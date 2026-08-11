export * as ConfigDocument from "./document"

import path from "path"
import { type ParseError, applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { ConfigDocument as ConfigDocumentSchema } from "@opencode-ai/schema/config-document"
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
  }
}

function applyPatchToText(text: string, patch: Patch): string {
  const value = patch.op === "mcp.server.remove" ? undefined : patch.value
  const edits = modify(text, jsonPathFor(patch), value, { formattingOptions: { tabSize: 2, insertSpaces: true } })
  return applyEdits(text, edits)
}

function restartImpactFor(_patch: Patch): RestartImpact {
  return "restart"
}

const REDACTED = "[redacted]"

// `effective()` is a display/summary read model (settings UI, catalog previews) -- unlike
// `readTarget`'s raw text, which is the direct-file-editing escape hatch the design post requires
// and must stay byte-real for diffing/patching. MCP is the one catalog chunk 1 knows carries
// secrets (Local.environment, Remote.headers, Remote.oauth.client_secret); each later catalog
// that gains a secret-shaped field extends this rather than growing a generic secret-scrubber.
function redactMcpServers(mcp: unknown): unknown {
  if (typeof mcp !== "object" || mcp === null || !("servers" in mcp)) return mcp
  const { servers, ...rest } = mcp as { servers?: unknown }
  if (typeof servers !== "object" || servers === null) return mcp
  const redactedServers = Object.fromEntries(
    Object.entries(servers as Record<string, unknown>).map(([name, server]) => {
      if (typeof server !== "object" || server === null) return [name, server]
      const next = { ...(server as Record<string, unknown>) }
      if (next.environment && typeof next.environment === "object")
        next.environment = Object.fromEntries(Object.keys(next.environment as object).map((k) => [k, REDACTED]))
      if (next.headers && typeof next.headers === "object")
        next.headers = Object.fromEntries(Object.keys(next.headers as object).map((k) => [k, REDACTED]))
      if (next.oauth && typeof next.oauth === "object" && "client_secret" in next.oauth)
        next.oauth = { ...(next.oauth as object), client_secret: REDACTED }
      return [name, next]
    }),
  )
  return { ...rest, servers: redactedServers }
}

function redactField(key: string, value: unknown): unknown {
  return key === "mcp" ? redactMcpServers(value) : value
}

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
   * target's own text, preserving comments and any fields this schema doesn't know about. */
  readonly applyPatch: (
    id: TargetID,
    expectedHash: string,
    patch: Patch,
  ) => Effect.Effect<ApplyResult, TargetNotFoundError | StaleHashError>
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
      return new ReadResult({ target, text, hash: Hash.sha256(text), parsed, diagnostics })
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
