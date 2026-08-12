import path from "path"
import fs from "fs/promises"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ConfigDocument } from "@opencode-ai/core/config/document"
import { Hash } from "@opencode-ai/core/util/hash"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

function testLayer(directory: string, globalDirectory = path.join(directory, "global"), projectDirectory = directory) {
  const locationLayer = Layer.succeed(
    Location.Service,
    Location.Service.of(
      location({ directory: AbsolutePath.make(directory) }, { projectDirectory: AbsolutePath.make(projectDirectory) }),
    ),
  )
  return AppNodeBuilder.build(LayerNode.group([ConfigDocument.node]), [
    [Location.node, locationLayer],
    [Global.node, Global.layerWith({ config: globalDirectory })],
  ])
}

function withTmp<A>(run: (tmp: { path: string }) => Effect.Effect<A>) {
  return Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap(run))
}

describe("ConfigDocument", () => {
  it.live("lists a creatable global and project target when neither file exists yet", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        const doc = yield* ConfigDocument.Service
        const targets = yield* doc.listTargets()

        const global = targets.find((t) => t.kind === "global")
        const project = targets.find((t) => t.kind === "project")
        expect(global?.exists).toBe(false)
        expect(global?.path).toBe(path.join(tmp.path, "global", "opencode.jsonc"))
        expect(project?.exists).toBe(false)
        expect(project?.path).toBe(path.join(tmp.path, "opencode.jsonc"))
      }).pipe(Effect.provide(testLayer(tmp.path))).pipe(Effect.orDie),
    ),
  )

  it.live("lists an existing file over a creatable default", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "opencode.json"), JSON.stringify({ shell: "/bin/zsh" })))

        return yield* Effect.gen(function* () {
          const doc = yield* ConfigDocument.Service
          const project = (yield* doc.listTargets()).find((t) => t.kind === "project")
          expect(project?.exists).toBe(true)
          expect(project?.path).toBe(path.join(tmp.path, "opencode.json"))
        }).pipe(Effect.provide(testLayer(tmp.path))).pipe(Effect.orDie)
      }),
    ),
  )

  it.live("readTarget returns raw text, hash, parsed value, and no diagnostics for valid jsonc", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        const text = `{\n  // a comment\n  "shell": "/bin/zsh"\n}\n`
        yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "opencode.json"), text))

        return yield* Effect.gen(function* () {
          const doc = yield* ConfigDocument.Service
          const project = (yield* doc.listTargets()).find((t) => t.kind === "project")!
          const read = yield* doc.readTarget(project.id)

          expect(read.text).toBe(text)
          expect(read.diagnostics).toEqual([])
          expect((read.parsed as { shell?: string }).shell).toBe("/bin/zsh")
        }).pipe(Effect.provide(testLayer(tmp.path))).pipe(Effect.orDie)
      }),
    ),
  )

  it.live("readTarget surfaces a diagnostic for malformed jsonc instead of throwing, and never leaks a secret in it", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        // Malformed AND secret-bearing (Henry, TKT-323 feedback #191 follow-up): a fixture that is
        // merely malformed can't distinguish "fails closed" from "happens not to touch mcp" -- the
        // secret is what proves this leak class can never return silently.
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(tmp.path, "opencode.json"),
            '{ "mcp": { "servers": { "local": { "environment": { "API_KEY": "sk-real-secret" } } } } invalid',
          ),
        )

        return yield* Effect.gen(function* () {
          const doc = yield* ConfigDocument.Service
          const project = (yield* doc.listTargets()).find((t) => t.kind === "project")!
          const read = yield* doc.readTarget(project.id)

          expect(read.diagnostics.length).toBeGreaterThan(0)
          expect(read.diagnostics[0]?.severity).toBe("error")
          expect(read.text).toBeInstanceOf(ConfigDocument.RedactionWithheld)
          expect(JSON.stringify(read)).not.toContain("sk-real-secret")
        }).pipe(Effect.provide(testLayer(tmp.path))).pipe(Effect.orDie)
      }),
    ),
  )

  it.live("readTarget fails with TargetNotFoundError for an id from a different discovery", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        const doc = yield* ConfigDocument.Service
        const exit = yield* doc.readTarget(ConfigDocument.TargetID.make("project:nonsense")).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
      }).pipe(Effect.provide(testLayer(tmp.path))).pipe(Effect.orDie),
    ),
  )

  it.live("effective merges global and project with the project file winning, and reports provenance", () =>
    withTmp((tmp) => {
      const global = path.join(tmp.path, "global")
      return Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await fs.mkdir(global, { recursive: true })
          await fs.writeFile(path.join(global, "opencode.json"), JSON.stringify({ shell: "/bin/bash", username: "global-user" }))
          await fs.writeFile(path.join(tmp.path, "opencode.json"), JSON.stringify({ shell: "/bin/zsh" }))
        })

        return yield* Effect.gen(function* () {
          const doc = yield* ConfigDocument.Service
          const targets = yield* doc.listTargets()
          const projectTarget = targets.find((t) => t.kind === "project")!
          const globalTarget = targets.find((t) => t.kind === "global")!

          const { fields } = yield* doc.effective()
          expect(fields.shell?.value).toBe("/bin/zsh")
          expect(fields.shell?.source).toBe(projectTarget.id)
          expect(fields.username?.value).toBe("global-user")
          expect(fields.username?.source).toBe(globalTarget.id)
        }).pipe(Effect.provide(testLayer(tmp.path, global))).pipe(Effect.orDie)
      })
    }),
  )

  // INVERTED (TKT-323, feedback #191): this pinning test previously asserted the opposite of
  // what it now asserts, on purpose. `readTarget` used to return the real secret values in `text`
  // and `parsed` -- the same protocol group as the redacted `effective()`, so a client wanting the
  // real values just called the sibling endpoint. That was a documented decision
  // (document.ts:88-89's old comment argued the direct-file-editing escape hatch needed byte-real
  // text so a patch computed against it would not corrupt a secret). The decision is REVERSED:
  // `applyPatch` never serializes text wholesale -- `Patch` is a typed, allowlisted field-op union
  // applied against text the server re-reads itself, so an editor working from a redacted view
  // cannot corrupt a value it never saw. Every API read response is now always redacted; the
  // escape hatch is editing the file on disk directly. See document.ts's comment above
  // `mcpSecretPaths` and FORK.md's divergence ledger for the full decision record.
  it.live("readTarget redacts MCP secrets in both text and parsed, same as effective", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        const filepath = path.join(tmp.path, "opencode.json")
        yield* Effect.promise(() =>
          fs.writeFile(
            filepath,
            JSON.stringify({
              mcp: {
                servers: {
                  local: { type: "local", command: ["x"], environment: { API_KEY: "sk-real-secret" } },
                  remote: {
                    type: "remote",
                    url: "https://mcp.example.com",
                    headers: { Authorization: "Bearer real-token" },
                    oauth: { client_id: "public-id", client_secret: "real-client-secret" },
                  },
                },
              },
            }),
          ),
        )

        return yield* Effect.gen(function* () {
          const doc = yield* ConfigDocument.Service
          const project = (yield* doc.listTargets()).find((t) => t.kind === "project")!

          const { fields } = yield* doc.effective()
          const mcp = fields.mcp?.value as {
            servers: {
              local: { environment: Record<string, string> }
              remote: { headers: Record<string, string>; oauth: { client_id: string; client_secret: string } }
            }
          }
          expect(mcp.servers.local.environment.API_KEY).toBe("[redacted]")
          expect(mcp.servers.remote.headers.Authorization).toBe("[redacted]")
          expect(mcp.servers.remote.oauth.client_secret).toBe("[redacted]")
          expect(mcp.servers.remote.oauth.client_id).toBe("public-id")

          // readTarget is a read response like any other -- the real values must never reach the
          // wire, in text OR parsed, on either endpoint of this protocol group.
          const read = yield* doc.readTarget(project.id)
          expect(read.text).not.toContain("sk-real-secret")
          expect(read.text).not.toContain("Bearer real-token")
          expect(read.text).not.toContain("real-client-secret")
          expect(read.text).toContain("[redacted]")
          // oauth.client_id is not secret-shaped -- confirms redaction is by allowlisted field,
          // not a blanket scrub of the whole mcp block.
          expect(read.text).toContain("public-id")

          const parsedMcp = read.parsed as {
            mcp: {
              servers: {
                local: { environment: Record<string, string> }
                remote: { headers: Record<string, string>; oauth: { client_id: string; client_secret: string } }
              }
            }
          }
          expect(parsedMcp.mcp.servers.local.environment.API_KEY).toBe("[redacted]")
          expect(parsedMcp.mcp.servers.remote.headers.Authorization).toBe("[redacted]")
          expect(parsedMcp.mcp.servers.remote.oauth.client_secret).toBe("[redacted]")
          expect(parsedMcp.mcp.servers.remote.oauth.client_id).toBe("public-id")

          // hash is still computed over the REAL text -- applyPatch's optimistic-concurrency
          // check must compare against the actual on-disk file, never the redacted display copy.
          const raw = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
          expect(read.hash).toBe(Hash.sha256(raw))
        }).pipe(Effect.provide(testLayer(tmp.path))).pipe(Effect.orDie)
      }),
    ),
  )

  // Regression for a Copilot review finding on PR #32, flipped by a lead ruling that superseded
  // the fix Copilot itself suggested (lenient parse): `parseAndDiagnose` discards its whole
  // `parsed` value on ANY diagnostic, even one unrelated to mcp -- a lenient recovery parse can
  // itself silently DROP the secret-bearing branch when a malformed region swallows it, so a
  // best-effort redaction is only a guarantee in the common case. The ruling: fail closed instead
  // -- withhold `text` entirely rather than return a redaction that isn't reliably complete. mcp is
  // valid and appears before a genuine, unrelated syntax error (a missing colon) later in the same
  // document -- text must still be withheld, not redacted, once ANY diagnostic exists.
  it.live("readTarget withholds text, rather than redact best-effort, when the document has a syntax error", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        const filepath = path.join(tmp.path, "opencode.json")
        const text = `{
  "mcp": { "servers": { "local": { "type": "local", "command": ["x"], "environment": { "API_KEY": "sk-real-secret" } } } },
  "bad_field" 1
}`
        yield* Effect.promise(() => fs.writeFile(filepath, text))

        return yield* Effect.gen(function* () {
          const doc = yield* ConfigDocument.Service
          const project = (yield* doc.listTargets()).find((t) => t.kind === "project")!
          const read = yield* doc.readTarget(project.id)

          expect(read.diagnostics.length).toBeGreaterThan(0)
          expect(read.text).toBeInstanceOf(ConfigDocument.RedactionWithheld)
          expect((read.text as ConfigDocument.RedactionWithheld).reason).toBe("could-not-parse")
          expect(JSON.stringify(read)).not.toContain("sk-real-secret")
        }).pipe(Effect.provide(testLayer(tmp.path))).pipe(Effect.orDie)
      }),
    ),
  )

  it.live("validatePatch previews the merged effect of an mcp.server.set without writing the file", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        const text = `{\n  "mcp": { "servers": {} }\n}\n`
        yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "opencode.json"), text))

        return yield* Effect.gen(function* () {
          const doc = yield* ConfigDocument.Service
          const project = (yield* doc.listTargets()).find((t) => t.kind === "project")!

          const { diagnostics, preview } = yield* doc.validatePatch(project.id, {
            op: "mcp.server.set",
            name: "local",
            value: { type: "local", command: ["node", "server.js"] },
          })

          expect(diagnostics).toEqual([])
          expect((preview.fields.mcp?.value as { servers?: Record<string, unknown> })?.servers?.local).toMatchObject({
            type: "local",
            command: ["node", "server.js"],
          })
          // Nothing was written -- validatePatch is read-only.
          expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "opencode.json"), "utf8"))).toBe(text)
        }).pipe(Effect.provide(testLayer(tmp.path))).pipe(Effect.orDie)
      }),
    ),
  )

  it.live("applyPatch writes atomically, preserves comments, and returns a fresh hash", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        const filepath = path.join(tmp.path, "opencode.json")
        const text = `{\n  // keep me\n  "shell": "/bin/zsh",\n  "mcp": { "servers": {} }\n}\n`
        yield* Effect.promise(() => fs.writeFile(filepath, text))

        return yield* Effect.gen(function* () {
          const doc = yield* ConfigDocument.Service
          const project = (yield* doc.listTargets()).find((t) => t.kind === "project")!
          const read = yield* doc.readTarget(project.id)

          const result = yield* doc.applyPatch(project.id, read.hash, {
            op: "mcp.server.set",
            name: "local",
            value: { type: "local", command: ["node", "server.js"] },
          })

          expect(result.restartImpact).toBe("restart")
          const written = yield* Effect.promise(() => fs.readFile(filepath, "utf8"))
          expect(written).toContain("// keep me")
          expect(written).toContain('"shell": "/bin/zsh"')
          expect(JSON.parse(written.replace(/\/\/.*$/gm, "")).mcp.servers.local).toEqual({
            type: "local",
            command: ["node", "server.js"],
          })
          // No leftover temp file.
          const entries = yield* Effect.promise(() => fs.readdir(tmp.path))
          expect(entries.filter((name) => name.includes(".tmp"))).toEqual([])
        }).pipe(Effect.provide(testLayer(tmp.path))).pipe(Effect.orDie)
      }),
    ),
  )

  it.live("applyPatch removes a server and rejects a stale hash without writing", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        const filepath = path.join(tmp.path, "opencode.json")
        const text = JSON.stringify({ mcp: { servers: { local: { type: "local", command: ["x"] } } } })
        yield* Effect.promise(() => fs.writeFile(filepath, text))

        return yield* Effect.gen(function* () {
          const doc = yield* ConfigDocument.Service
          const project = (yield* doc.listTargets()).find((t) => t.kind === "project")!
          const read = yield* doc.readTarget(project.id)

          const stale = yield* doc.applyPatch(project.id, "not-the-real-hash", { op: "mcp.server.remove", name: "local" }).pipe(Effect.exit)
          expect(stale._tag).toBe("Failure")
          expect(yield* Effect.promise(() => fs.readFile(filepath, "utf8"))).toBe(text)

          const result = yield* doc.applyPatch(project.id, read.hash, { op: "mcp.server.remove", name: "local" })
          const written = JSON.parse(yield* Effect.promise(() => fs.readFile(filepath, "utf8")))
          expect(written.mcp.servers.local).toBeUndefined()
          expect(result.hash).not.toBe(read.hash)
        }).pipe(Effect.provide(testLayer(tmp.path))).pipe(Effect.orDie)
      }),
    ),
  )

  // The corollary to the readTarget-redaction reversal above: a UI that reads a redacted value,
  // never touches it, and patches the field straight back must not silently persist the literal
  // sentinel as the real secret -- it would look like a successful save and only surface later
  // when the integration stops authenticating. This is only safe to enforce now that readTarget
  // never returns a real value for a client to accidentally echo back unredacted.
  it.live("applyPatch rejects a patch that would write the redaction sentinel over a secret field", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        const filepath = path.join(tmp.path, "opencode.json")
        const text = JSON.stringify({
          mcp: { servers: { local: { type: "local", command: ["x"], environment: { API_KEY: "sk-real-secret" } } } },
        })
        yield* Effect.promise(() => fs.writeFile(filepath, text))

        return yield* Effect.gen(function* () {
          const doc = yield* ConfigDocument.Service
          const project = (yield* doc.listTargets()).find((t) => t.kind === "project")!
          const read = yield* doc.readTarget(project.id)

          const rejected = yield* doc
            .applyPatch(project.id, read.hash, {
              op: "mcp.server.set",
              name: "local",
              value: { type: "local", command: ["x"], environment: { API_KEY: "[redacted]" } },
            })
            .pipe(Effect.exit)
          expect(rejected._tag).toBe("Failure")
          if (rejected._tag === "Failure")
            expect(rejected.cause.toString()).toContain("Config.Document.RedactedValueRejectedError")

          // Nothing written -- the real secret survives an accidental read-then-write round trip.
          const untouched = yield* Effect.promise(() => fs.readFile(filepath, "utf8"))
          expect(untouched).toBe(text)

          // A genuinely new value for the same field is still allowed -- only the literal
          // sentinel is rejected, not the field itself.
          const result = yield* doc.applyPatch(project.id, read.hash, {
            op: "mcp.server.set",
            name: "local",
            value: { type: "local", command: ["x"], environment: { API_KEY: "sk-new-real-secret" } },
          })
          expect(result.hash).not.toBe(read.hash)
        }).pipe(Effect.provide(testLayer(tmp.path))).pipe(Effect.orDie)
      }),
    ),
  )
})
