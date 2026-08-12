export * as ConfigDocument from "./document"

import path from "path"
import { type ParseError, applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { ConfigDocument as ConfigDocumentSchema } from "@opencode-ai/schema/config-document"
import { ConfigMCP } from "@opencode-ai/schema/config-mcp"
import { Config } from "../config"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Location } from "../location"
import { makeLocationNode } from "../effect/app-node"
import { Hash } from "../util/hash"

const NAMES = ["opencode.json", "opencode.jsonc"] as const
const DECODE_OPTIONS = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const

export const TargetKind = ConfigDocumentSchema.TargetKind
export type TargetKind = ConfigDocumentSchema.TargetKind

export const TargetID = ConfigDocumentSchema.TargetID
export type TargetID = ConfigDocumentSchema.TargetID

export const TargetSummary = ConfigDocumentSchema.TargetSummary
export type TargetSummary = ConfigDocumentSchema.TargetSummary

export const Diagnostic = ConfigDocumentSchema.Diagnostic
export type Diagnostic = ConfigDocumentSchema.Diagnostic

export const ReadResult = ConfigDocumentSchema.ReadResult
export type ReadResult = ConfigDocumentSchema.ReadResult

export const RedactionWithheld = ConfigDocumentSchema.RedactionWithheld
export type RedactionWithheld = ConfigDocumentSchema.RedactionWithheld

export const RestartImpact = ConfigDocumentSchema.RestartImpact
export type RestartImpact = ConfigDocumentSchema.RestartImpact

export const ProvenanceField = ConfigDocumentSchema.ProvenanceField
export type ProvenanceField = ConfigDocumentSchema.ProvenanceField

export const EffectiveResult = ConfigDocumentSchema.EffectiveResult
export type EffectiveResult = ConfigDocumentSchema.EffectiveResult

export const Patch = ConfigDocumentSchema.Patch
export type Patch = ConfigDocumentSchema.Patch

export const ValidateResult = ConfigDocumentSchema.ValidateResult
export type ValidateResult = ConfigDocumentSchema.ValidateResult

export const ApplyResult = ConfigDocumentSchema.ApplyResult
export type ApplyResult = ConfigDocumentSchema.ApplyResult

// Opaque, derived from the server's own discovery -- never a raw path a browser could send us.
// A client selects a target by this id; the server re-resolves it against a fresh directory scan
// on every call, so a stale id from a moved/deleted file simply fails to resolve.
function makeTargetID(kind: TargetKind, filePath: string): TargetID {
  return TargetID.make(`${kind}:${Hash.fast(filePath)}`)
}

export class TargetNotFoundError extends Schema.TaggedErrorClass<TargetNotFoundError>()(
  "Config.Document.TargetNotFoundError",
  { id: Schema.String },
) {}

export class StaleHashError extends Schema.TaggedErrorClass<StaleHashError>()("Config.Document.StaleHashError", {
  id: Schema.String,
  expected: Schema.String,
  actual: Schema.String,
}) {}

function jsonPathFor(patch: Patch): Array<string> {
  switch (patch.op) {
    case "mcp.server.set":
    case "mcp.server.remove":
      return ["mcp", "servers", patch.name]
    case "mcp.server.credential.set":
    case "mcp.server.credential.remove":
      return patch.key.field === "oauth.client_secret"
        ? ["mcp", "servers", patch.name, "oauth", "client_secret"]
        : ["mcp", "servers", patch.name, patch.key.field, patch.key.key]
  }
}

// Reads the target's CURRENT (pre-edit) server value for `name`, straight from the raw parsed
// text -- not a typed decode, so a malformed-but-present secret field is still found and carried
// forward rather than silently dropped by a failed decode. Returns `undefined` if the server
// doesn't exist yet (a create) or the document doesn't parse.
function existingServerRaw(text: string, name: string): unknown {
  const { parsed } = parseAndDiagnose(text)
  if (typeof parsed !== "object" || parsed === null) return undefined
  const mcp = (parsed as Record<string, unknown>).mcp
  if (typeof mcp !== "object" || mcp === null) return undefined
  const servers = (mcp as Record<string, unknown>).servers
  if (typeof servers !== "object" || servers === null) return undefined
  return (servers as Record<string, unknown>)[name]
}

// Carries forward whatever secret-shaped fields the existing server already has onto an incoming
// `mcp.server.set` patch's non-secret value -- the actual mechanism that makes the type-level
// narrowing (`ConfigMCP.ServerNonSecret`) safe to write with: the patch value structurally cannot
// mention environment/headers/oauth.client_secret, so this function is what puts the EXISTING
// ones back rather than leaving them wiped by `modify`'s whole-value replace at
// `["mcp","servers",name]`. Only carries forward when the server's own `type` is unchanged --
// local's `environment` and remote's `headers`/`oauth` are different shapes, so a type change
// (local server edited into a remote one, or vice versa) has nothing compatible to carry over;
// treating it as a fresh server on type change is correct, not a gap.
function mergeNonSecretPatch(value: ConfigMCP.ServerNonSecret, existingRaw: unknown): unknown {
  const merged: Record<string, unknown> = { ...value }
  if (typeof existingRaw !== "object" || existingRaw === null) return merged
  const existing = existingRaw as Record<string, unknown>
  if (existing.type !== value.type) return merged
  if (value.type === "local" && existing.environment !== undefined) merged.environment = existing.environment
  if (value.type === "remote") {
    if (existing.headers !== undefined) merged.headers = existing.headers
    const existingOAuth = existing.oauth
    if (value.oauth === false) {
      // Explicit disable -- the incoming patch deliberately says "no oauth", which wipes the
      // existing block (including its secret) on purpose. Not a gap: this is the one case where
      // destroying the secret IS the ask.
    } else if (value.oauth && typeof value.oauth === "object") {
      // The incoming patch specifies a real oauth object (a future oauth-editing UI --
      // `ServerNonSecret`'s `OAuthNonSecret` structurally cannot carry `client_secret`, so carry
      // the existing one forward onto the new shape).
      if (existingOAuth && typeof existingOAuth === "object" && "client_secret" in existingOAuth) {
        merged.oauth = { ...value.oauth, client_secret: (existingOAuth as Record<string, unknown>).client_secret }
      }
    } else if (existingOAuth !== undefined) {
      // The incoming patch doesn't mention oauth at all -- the current UI never edits it, so
      // every `mcp.server.set` this cut sends omits the field. Without this branch, the whole
      // existing oauth block (client_id, scope, callback_port, redirect_uri, AND client_secret)
      // silently disappears on any edit -- url, disabled, timeout -- exactly the secret-loss
      // shape this PR exists to make inexpressible, just missed for this one field (Copilot
      // review, PR #40). Carried forward whole, same treatment as headers/environment above.
      merged.oauth = existingOAuth
    }
  }
  return merged
}

function applyPatchToText(text: string, patch: Patch): string {
  if (patch.op === "mcp.server.set") {
    const merged = mergeNonSecretPatch(patch.value, existingServerRaw(text, patch.name))
    const edits = modify(text, jsonPathFor(patch), merged, { formattingOptions: { tabSize: 2, insertSpaces: true } })
    return applyEdits(text, edits)
  }
  const value = patch.op === "mcp.server.remove" || patch.op === "mcp.server.credential.remove" ? undefined : patch.value
  const edits = modify(text, jsonPathFor(patch), value, { formattingOptions: { tabSize: 2, insertSpaces: true } })
  return applyEdits(text, edits)
}

function restartImpactFor(_patch: Patch): RestartImpact {
  return "restart"
}

const REDACTED = "[redacted]"

// REVERSES a documented decision from chunk 1 (this comment previously read: "`readTarget`'s raw
// text ... is the direct-file-editing escape hatch the design post requires and must stay
// byte-real for diffing/patching"). That rationale is refuted (feedback #191, Henry's TKT-323
// settings-v2 design note §0, Ethan's ruling): the round-trip-corruption concern it guards against
// cannot occur through any shipped write path. `applyPatch` never replaces the file text wholesale
// -- `ConfigDocument.Patch` is a typed, allowlisted union of field operations
// (`mcp.server.set`/`mcp.server.remove`), applied against text the server re-reads itself. A field
// the client did not edit is simply absent from the patch and is never written back, so an editor
// working from a redacted display view cannot corrupt a secret it never saw. Chunk 1 shipped
// `readTarget` unredacted anyway, on the SAME `server.config-document` protocol group as the
// redacted `effective()` -- a client wanting the real values just calls the sibling endpoint.
// "Secret values are write-only and redacted in read responses" (build post) governs every read
// path, `readTarget` included; there is no shipped consumer of raw secret values today (Henry
// enumerated). The escape hatch is now "edit the file on disk yourself"; every API read response
// is always redacted, with no operation to reveal a value. See FORK.md's divergence ledger for the
// decision record and the reveal-op path back, should one ever be explicitly authorised.
//
// MCP is the one catalog chunk 1 knows carries secrets (Local.environment, Remote.headers,
// Remote.oauth.client_secret); each later catalog that gains a secret-shaped field extends
// `mcpSecretPaths` rather than growing a generic secret-scrubber (chunk 1's own deliberate choice:
// a key-name scrubber both misses `client_secret` and over-redacts innocent fields).
type SecretPath = string[]

// One enumeration of every secret-bearing field's JSON path within a parsed `mcp` value, shared by
// the object redactor (below), the raw-text redactor (`redactSecretsInText`), and `applyPatch`'s
// sentinel-rejection check -- so all three read the same allowlist rather than three independently
// maintained ones that can drift.
// Paths are relative to the `mcp` value itself (`["servers", name, ...]`, no leading "mcp"
// segment) -- callers operating on the whole document (`redactSecretsInText`, which edits raw
// text via a document-rooted JSON path) prepend "mcp" themselves; callers already holding just
// the `mcp` sub-value (`redactMcpServers`, `patchWritesRedactedSentinel`) use the path as-is.
function mcpSecretPaths(mcp: unknown): SecretPath[] {
  if (typeof mcp !== "object" || mcp === null || !("servers" in mcp)) return []
  const { servers } = mcp as { servers?: unknown }
  if (typeof servers !== "object" || servers === null) return []
  const paths: SecretPath[] = []
  for (const [name, server] of Object.entries(servers as Record<string, unknown>)) {
    if (typeof server !== "object" || server === null) continue
    const s = server as Record<string, unknown>
    if (s.environment && typeof s.environment === "object")
      for (const key of Object.keys(s.environment as object)) paths.push(["servers", name, "environment", key])
    if (s.headers && typeof s.headers === "object")
      for (const key of Object.keys(s.headers as object)) paths.push(["servers", name, "headers", key])
    if (s.oauth && typeof s.oauth === "object" && "client_secret" in s.oauth)
      paths.push(["servers", name, "oauth", "client_secret"])
  }
  return paths
}

function redactMcpServers(mcp: unknown): unknown {
  const paths = mcpSecretPaths(mcp)
  if (paths.length === 0) return mcp
  // `mcp` is already a parsed, JSON-safe value (from jsonc-parser or an in-memory Patch value),
  // so a JSON round-trip is a safe, simple deep clone -- nothing here is ever a class instance,
  // Date, or other value JSON.stringify would lossily reshape.
  const next = JSON.parse(JSON.stringify(mcp))
  for (const path of paths) {
    let cursor: Record<string, unknown> = next
    for (let i = 0; i < path.length - 1; i++) cursor = cursor[path[i]] as Record<string, unknown>
    cursor[path[path.length - 1]] = REDACTED
  }
  return next
}

// Redacts the SAME secret locations directly in the raw JSONC text, via `jsonc-parser`'s own
// `modify`/`applyEdits` -- the identical mechanism `applyPatchToText` already uses for writes --
// rather than a blind string search-replace, which risks over-redacting a secret value that
// happens to recur elsewhere (a comment, another field) or under-redacting if jsonc-parser's own
// serialization of the value differs byte-for-byte from a naive match.
function redactSecretsInText(text: string, mcp: unknown): string {
  const paths = mcpSecretPaths(mcp)
  let redacted = text
  for (const path of paths) {
    const edits = modify(redacted, ["mcp", ...path], REDACTED, { formattingOptions: { tabSize: 2, insertSpaces: true } })
    redacted = applyEdits(redacted, edits)
  }
  return redacted
}

function redactField(key: string, value: unknown): unknown {
  return key === "mcp" ? redactMcpServers(value) : value
}

// Applied to a WHOLE parsed document (readTarget's `parsed`), as opposed to `redactField`, which
// `computeEffective` calls per top-level key while building its field-by-field provenance map.
function redactParsed(parsed: unknown): unknown {
  // Array.isArray is required, not just the typeof/null guard: `typeof [] === "object"` and
  // `[] !== null`, so an array-rooted document (e.g. a malformed config with an array at the top
  // level) would otherwise pass through Object.fromEntries(Object.entries(...)) and come back as a
  // plain object with numeric string keys -- silently reshaping the parsed value beyond the
  // intended mcp redaction (Copilot review, PR #32).
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return parsed
  return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, redactField(k, v)]))
}

// The corollary Henry's note names as mandatory once readTarget is redacted: a UI that reads a
// redacted value, doesn't touch it, and patches the field back would otherwise persist the
// literal string "[redacted]" as the real secret -- a silent, self-inflicted secret loss that
// only surfaces later when the integration stops authenticating. Post-narrowing (TKT-323 MCP
// config editing), only `mcp.server.credential.set` can carry a secret value at all --
// `mcp.server.set`'s type (`ConfigMCP.ServerNonSecret`) structurally cannot mention a secret
// field, so there is nothing on that op left for this check to catch. Direct string comparison,
// not `mcpSecretPaths`: a credential patch's `value` already IS the secret value itself (never a
// nested object to walk), so there is no allowlist to re-derive here.
function patchWritesRedactedSentinel(patch: Patch): boolean {
  return patch.op === "mcp.server.credential.set" && patch.value === REDACTED
}

export class RedactedValueRejectedError extends Schema.TaggedErrorClass<RedactedValueRejectedError>()(
  "Config.Document.RedactedValueRejectedError",
  { id: Schema.String },
) {}

function parseDiagnostics(errors: ParseError[]): Diagnostic[] {
  return errors.map(
    (e) => new Diagnostic({ severity: "error", message: printParseErrorCode(e.error), offset: e.offset, length: e.length }),
  )
}

// Parses jsonc text and, only if it parses cleanly, decodes it against Config.Info. A target with
// parse errors or schema violations contributes nothing to a merge rather than dying -- matching
// Config.Service's own `if (!info) return` skip-on-error behavior in config.ts.
function parseAndDiagnose(text: string): { parsed: unknown; info: Config.Info | undefined; diagnostics: Diagnostic[] } {
  if (text.trim() === "") return { parsed: undefined, info: undefined, diagnostics: [] }
  const errors: ParseError[] = []
  const parsed: unknown = parse(text, errors, { allowTrailingComma: true })
  const diagnostics = parseDiagnostics(errors)
  if (diagnostics.length > 0) return { parsed: undefined, info: undefined, diagnostics }
  const decoded = Schema.decodeUnknownOption(Config.Info, DECODE_OPTIONS)(parsed)
  const info = Option.getOrUndefined(decoded)
  if (!info) {
    return {
      parsed,
      info: undefined,
      diagnostics: [new Diagnostic({ severity: "error", message: "Does not match the configuration schema" })],
    }
  }
  return { parsed, info, diagnostics: [] }
}

export interface Interface {
  /** Global and project documents this location can edit, lowest to highest precedence. A target
   * that does not exist yet is still listed (as a create-here location) so the UI can offer
   * "add a config here" without the browser ever naming a raw path. Scoped to top-level
   * opencode.json(c) files for chunk 1 -- `.opencode`-directory supplementary files are not yet
   * listed as targets (see TKT-323 diary). */
  readonly listTargets: () => Effect.Effect<TargetSummary[]>
  readonly readTarget: (id: TargetID) => Effect.Effect<ReadResult, TargetNotFoundError>
  /** Merged config values with per-field source provenance, computed fresh from disk on every
   * call (not the cached snapshot `Config.Service` takes at location-open time) so an editing UI
   * always sees current state. */
  readonly effective: () => Effect.Effect<EffectiveResult>
  readonly validatePatch: (id: TargetID, patch: Patch) => Effect.Effect<ValidateResult, TargetNotFoundError>
  /** Atomic temp-file-then-rename replacement, gated on an optimistic hash check against the
   * target's current on-disk content (StaleHashError on mismatch -- a 409 at the protocol layer).
   * Never serializes `Config.Info` back to the file: only ever applies a typed jsonc patch to the
   * target's own text, preserving comments and any fields this schema doesn't know about. Rejects
   * (RedactedValueRejectedError) a patch that writes the literal redaction sentinel to a secret
   * field -- a read-then-write UI that never touched the real value must not silently overwrite
   * it, since `readTarget`'s own response never carries that value for the client to echo back. */
  readonly applyPatch: (
    id: TargetID,
    expectedHash: string,
    patch: Patch,
  ) => Effect.Effect<ApplyResult, TargetNotFoundError | StaleHashError | RedactedValueRejectedError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ConfigDocument") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service

    const discoverTargets = Effect.fn("ConfigDocument.discoverTargets")(function* () {
      const targets: TargetSummary[] = []

      const globalCandidates = NAMES.map((name) => path.join(global.config, name))
      const globalExists = yield* Effect.forEach(globalCandidates, (p) => fs.existsSafe(p))
      const globalIndex = globalExists.indexOf(true)
      const globalPath = globalIndex >= 0 ? globalCandidates[globalIndex]! : globalCandidates[1]!
      targets.push(
        new TargetSummary({
          id: makeTargetID("global", globalPath),
          kind: "global",
          path: globalPath,
          exists: globalIndex >= 0,
        }),
      )

      const discovered = yield* fs
        .up({ targets: [...NAMES], start: location.directory, stop: location.project.directory })
        .pipe(Effect.orDie)
      if (discovered.length > 0) {
        for (const p of discovered)
          targets.push(new TargetSummary({ id: makeTargetID("project", p), kind: "project", path: p, exists: true }))
      } else {
        const projectPath = path.join(location.project.directory, "opencode.jsonc")
        targets.push(
          new TargetSummary({ id: makeTargetID("project", projectPath), kind: "project", path: projectPath, exists: false }),
        )
      }

      return targets
    })

    const findTarget = Effect.fn("ConfigDocument.findTarget")(function* (id: TargetID) {
      const targets = yield* discoverTargets()
      const found = targets.find((t) => t.id === id)
      if (!found) return yield* Effect.fail(new TargetNotFoundError({ id }))
      return found
    })

    const readTargetText = Effect.fn("ConfigDocument.readTargetText")(function* (target: TargetSummary) {
      return (yield* fs.readFileStringSafe(target.path).pipe(Effect.orDie)) ?? ""
    })

    // Global first, then project targets in closer-wins order (fs.up returns nearest-to-opened
    // last processed first, so reverse to make the nearest file win) -- same precedence rule as
    // Config.Service's own merge in config.ts. `override` lets validatePatch preview a not-yet-
    // written patch against this target's text while every other target still reads from disk.
    const computeEffective = Effect.fn("ConfigDocument.computeEffective")(function* (override?: {
      readonly id: TargetID
      readonly text: string
    }) {
      const targets = yield* discoverTargets()
      const ordered = [
        ...targets.filter((t) => t.kind === "global"),
        ...targets.filter((t) => t.kind === "project").toReversed(),
      ]

      const fields: Record<string, ProvenanceField> = {}
      for (const target of ordered) {
        const text = target.id === override?.id ? override.text : yield* readTargetText(target)
        const { info } = parseAndDiagnose(text)
        if (!info) continue
        for (const [key, value] of Object.entries(info)) {
          if (value === undefined) continue
          fields[key] = new ProvenanceField({ value: redactField(key, value), source: target.id })
        }
      }
      return new EffectiveResult({ fields })
    })

    const readTarget: Interface["readTarget"] = Effect.fn("ConfigDocument.readTarget")(function* (id) {
      const target = yield* findTarget(id)
      const text = yield* readTargetText(target)
      const { parsed, diagnostics } = parseAndDiagnose(text)
      // hash is over the REAL text, always -- applyPatch's optimistic-concurrency check compares
      // it against the actual on-disk file, so it must never be computed from the redacted display
      // copy a client echoes back.
      const hash = Hash.sha256(text)
      // Fail closed rather than redact best-effort (lead ruling, TKT-323 feedback #191 follow-up,
      // superseding an earlier lenient-parse fix reviewed on PR #32): a lenient parse can recover a
      // tree that silently DROPS the secret-bearing branch when a malformed region swallows it, so
      // the redactor would see no secrets while the raw text still carries them byte-for-byte. A
      // guarantee conditional on how badly the file is broken is not a guarantee. The escape hatch
      // for a broken config is editing it on disk directly (already the rule for every other read
      // path); these diagnostics are the fix-it information.
      if (diagnostics.length > 0) {
        return new ReadResult({
          target,
          text: new RedactionWithheld({ reason: "could-not-parse" }),
          hash,
          parsed: redactParsed(parsed),
          diagnostics,
        })
      }
      const mcp = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).mcp : undefined
      const redactedText = mcp === undefined ? text : redactSecretsInText(text, mcp)
      return new ReadResult({ target, text: redactedText, hash, parsed: redactParsed(parsed), diagnostics })
    })

    const validatePatch: Interface["validatePatch"] = Effect.fn("ConfigDocument.validatePatch")(function* (id, patch) {
      const target = yield* findTarget(id)
      const text = yield* readTargetText(target)
      const patchedText = applyPatchToText(text, patch)
      const { diagnostics } = parseAndDiagnose(patchedText)
      const preview = yield* computeEffective({ id, text: patchedText })
      return new ValidateResult({ diagnostics, preview })
    })

    const applyPatch: Interface["applyPatch"] = Effect.fn("ConfigDocument.applyPatch")(function* (id, expectedHash, patch) {
      if (patchWritesRedactedSentinel(patch)) return yield* Effect.fail(new RedactedValueRejectedError({ id }))
      const target = yield* findTarget(id)
      const text = yield* readTargetText(target)
      const actualHash = Hash.sha256(text)
      if (actualHash !== expectedHash) return yield* Effect.fail(new StaleHashError({ id, expected: expectedHash, actual: actualHash }))

      const patchedText = applyPatchToText(text, patch)
      const tempPath = `${target.path}.${process.pid}.${Date.now()}.tmp`
      yield* fs
        .writeWithDirs(tempPath, patchedText)
        .pipe(
          Effect.andThen(fs.rename(tempPath, target.path)),
          Effect.tapError(() => fs.remove(tempPath, { force: true }).pipe(Effect.ignore)),
          Effect.orDie,
        )

      return new ApplyResult({ hash: Hash.sha256(patchedText), restartImpact: restartImpactFor(patch) })
    })

    return Service.of({
      listTargets: discoverTargets,
      readTarget,
      effective: () => computeEffective(),
      validatePatch,
      applyPatch,
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [FSUtil.node, Global.node, Location.node] })
