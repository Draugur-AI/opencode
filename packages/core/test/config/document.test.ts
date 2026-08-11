import path from "path"
import fs from "fs/promises"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ConfigDocument } from "@opencode-ai/core/config/document"
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

  it.live("readTarget surfaces a diagnostic for malformed jsonc instead of throwing", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "opencode.json"), "{ invalid"))

        return yield* Effect.gen(function* () {
          const doc = yield* ConfigDocument.Service
          const project = (yield* doc.listTargets()).find((t) => t.kind === "project")!
          const read = yield* doc.readTarget(project.id)

          expect(read.diagnostics.length).toBeGreaterThan(0)
          expect(read.diagnostics[0]?.severity).toBe("error")
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

  it.live("effective redacts MCP secrets, but readTarget's raw text stays real for editing", () =>
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

          // The direct-file editor is a deliberate escape hatch (design post: "always show the
          // selected source document") -- it must show the REAL content, not a redacted one, or
          // a patch computed against it would corrupt the file's actual secret values.
          const read = yield* doc.readTarget(project.id)
          expect(read.text).toContain("sk-real-secret")
          expect(read.text).toContain("Bearer real-token")
          expect(read.text).toContain("real-client-secret")
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
})
