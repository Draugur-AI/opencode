import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigDocument } from "@opencode-ai/core/config/document"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillCatalog } from "@opencode-ai/core/skill-catalog"
import { SkillDiscovery } from "@opencode-ai/core/skill/discovery"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const discovery = Layer.succeed(SkillDiscovery.Service, SkillDiscovery.Service.of({ pull: () => Effect.succeed([]) }))

function testLayer(directory: string, globalDirectory = path.join(directory, "global"), projectDirectory = directory) {
  const locationLayer = Layer.succeed(
    Location.Service,
    Location.Service.of(
      location({ directory: AbsolutePath.make(directory) }, { projectDirectory: AbsolutePath.make(projectDirectory) }),
    ),
  )
  return AppNodeBuilder.build(LayerNode.group([SkillCatalog.node, SkillV2.node, ConfigDocument.node]), [
    [Location.node, locationLayer],
    [Global.node, Global.layerWith({ config: globalDirectory })],
    [SkillDiscovery.node, discovery],
  ])
}

function withTmp<A, E, R>(run: (tmp: { path: string }) => Effect.Effect<A, E, R>) {
  return Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap(run))
}

function write(directory: string, name: string, description: string) {
  return fs.writeFile(
    path.join(directory, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}`,
  )
}

const it = testEffect(Layer.empty)

describe("SkillCatalog", () => {
  it.live("reports both the winner and the shadowed loser, with provenance", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        const first = path.join(tmp.path, "first")
        const second = path.join(tmp.path, "second")
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(first, "review"), { recursive: true })
          await fs.mkdir(path.join(second, "review"), { recursive: true })
          await write(first, "review", "First")
          await write(second, "review", "Second")
        })

        return yield* Effect.gen(function* () {
          const skills = yield* SkillV2.Service
          yield* skills.transform((editor) => {
            editor.source({ type: "directory", path: AbsolutePath.make(first) })
            editor.source({ type: "directory", path: AbsolutePath.make(second) })
          })

          const catalog = yield* SkillCatalog.Service
          const entries = yield* catalog.list()

          expect(entries).toHaveLength(2)
          const winner = entries.find((entry) => !entry.shadowedBy)!
          const loser = entries.find((entry) => entry.shadowedBy)!
          expect(winner.skill.description).toBe("Second")
          expect(winner.sourceIndex).toBe(1)
          expect(loser.skill.description).toBe("First")
          expect(loser.sourceIndex).toBe(0)
          expect(loser.shadowedBy).toEqual({ source: { type: "directory", path: AbsolutePath.make(second) }, sourceIndex: 1 })

          // Same fact `SkillV2.list()` reports (winners only) -- the catalog must not disagree.
          const list = yield* skills.list()
          expect(list).toHaveLength(1)
          expect(list[0]!.description).toBe("Second")
        }).pipe(Effect.provide(testLayer(tmp.path))).pipe(Effect.orDie)
      }),
    ),
  )

  // Delete-the-fix, the shape Ethan's ruling specified: perturb which source is registered LAST
  // (closer-wins) and confirm the winner moves on BOTH surfaces together. A catalog computed by
  // its own independent walk could pass the test above by coincidence while still disagreeing
  // with SkillV2.list() under a different ordering -- this is what rules that out. Both calls
  // read `SkillV2.Service.entries()`, so there is no ordering under which they COULD diverge; if
  // a future change made the catalog re-derive its own merge, this is the test that would catch it.
  it.live("perturbing registration order moves the winner on SkillV2.list() and the catalog together", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        const first = path.join(tmp.path, "first")
        const second = path.join(tmp.path, "second")
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(first, "review"), { recursive: true })
          await fs.mkdir(path.join(second, "review"), { recursive: true })
          await write(first, "review", "First")
          await write(second, "review", "Second")
        })

        return yield* Effect.gen(function* () {
          const skills = yield* SkillV2.Service
          // Reversed from the test above: `first` registered LAST, so it should win this time.
          yield* skills.transform((editor) => {
            editor.source({ type: "directory", path: AbsolutePath.make(second) })
            editor.source({ type: "directory", path: AbsolutePath.make(first) })
          })

          const catalog = yield* SkillCatalog.Service
          const entries = yield* catalog.list()
          const winner = entries.find((entry) => !entry.shadowedBy)!
          expect(winner.skill.description).toBe("First")

          const list = yield* skills.list()
          expect(list[0]!.description).toBe("First")
        }).pipe(Effect.provide(testLayer(tmp.path))).pipe(Effect.orDie)
      }),
    ),
  )

  it.live("a directory source under the project root is attributed to the project target", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        const skillDir = path.join(tmp.path, "skill")
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(skillDir, "deploy"), { recursive: true })
          await write(skillDir, "deploy", "Deploy")
          await fs.writeFile(path.join(tmp.path, "opencode.json"), "{}")
        })

        return yield* Effect.gen(function* () {
          const skills = yield* SkillV2.Service
          yield* skills.transform((editor) => editor.source({ type: "directory", path: AbsolutePath.make(skillDir) }))

          const catalog = yield* SkillCatalog.Service
          const entries = yield* catalog.list()
          expect(entries).toHaveLength(1)
          expect(entries[0]!.target).toBeDefined()

          const documents = yield* ConfigDocument.Service
          const project = (yield* documents.listTargets()).find((target) => target.kind === "project")!
          expect(entries[0]!.target).toBe(project.id)
        }).pipe(Effect.provide(testLayer(tmp.path))).pipe(Effect.orDie)
      }),
    ),
  )

  it.live("a bare .opencode-tier directory with no co-located config falls back to the nearest enclosing target", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        // Mirrors config/plugin/skill.ts's own convention: a `.opencode/skill` directory with no
        // opencode.json(c) sitting IN THAT SAME directory. `ConfigDocument.listTargets()` (chunk
        // 1 scope) never lists `.opencode` directories as targets themselves -- see that method's
        // own doc comment -- so this directory source has no CO-LOCATED target to match exactly.
        const dotOpencode = path.join(tmp.path, ".opencode")
        const skillDir = path.join(dotOpencode, "skill")
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(skillDir, "deploy"), { recursive: true })
          await write(skillDir, "deploy", "Deploy")
          await fs.writeFile(path.join(tmp.path, "opencode.json"), "{}")
        })

        return yield* Effect.gen(function* () {
          const skills = yield* SkillV2.Service
          yield* skills.transform((editor) => editor.source({ type: "directory", path: AbsolutePath.make(skillDir) }))

          const catalog = yield* SkillCatalog.Service
          const entries = yield* catalog.list()

          const documents = yield* ConfigDocument.Service
          const project = (yield* documents.listTargets()).find((target) => target.kind === "project")!
          // Not undefined, and not the global fallback either -- the project opencode.json one
          // directory up is the nearest ENCLOSING target, not the only possible one.
          expect(entries[0]!.target).toBe(project.id)
        }).pipe(Effect.provide(testLayer(tmp.path))).pipe(Effect.orDie)
      }),
    ),
  )

  // Delete-the-fix for the fallback branch specifically: without `?? targets.find(kind ===
  // "global")`, `findEnclosingTarget` returns undefined here (confirmed red -- neither the
  // project nor the "global" test fixture directory encloses a sibling tmpdir), silently
  // reporting "no location" for a source that DOES have an enclosing config, just not a nearby
  // one. A directory source registered from outside the project tree entirely (e.g. an absolute
  // path in a document's `skills: []` array, config/plugin/skill.ts) has no project-tier target
  // above it at all -- global is the only target left that structurally encloses it.
  it.live("a directory source outside the project tree entirely falls back to the global target", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        const outside = yield* Effect.promise(() => tmpdir())
        const skillDir = path.join(outside.path, "skill")
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(skillDir, "deploy"), { recursive: true })
          await write(skillDir, "deploy", "Deploy")
          await fs.writeFile(path.join(tmp.path, "opencode.json"), "{}")
        })

        return yield* Effect.gen(function* () {
          const skills = yield* SkillV2.Service
          yield* skills.transform((editor) => editor.source({ type: "directory", path: AbsolutePath.make(skillDir) }))

          const catalog = yield* SkillCatalog.Service
          const entries = yield* catalog.list()

          const documents = yield* ConfigDocument.Service
          const global = (yield* documents.listTargets()).find((target) => target.kind === "global")!
          expect(entries[0]!.target).toBe(global.id)

          yield* Effect.promise(() => outside[Symbol.asyncDispose]())
        }).pipe(Effect.provide(testLayer(tmp.path))).pipe(Effect.orDie)
      }),
    ),
  )

  it.live("url and embedded sources carry no target -- there is no location to attribute", () =>
    withTmp((tmp) =>
      Effect.gen(function* () {
        return yield* Effect.gen(function* () {
          const skills = yield* SkillV2.Service
          yield* skills.transform((editor) => {
            editor.source({
              type: "embedded",
              skill: { name: "builtin", location: AbsolutePath.make("/builtin/skill"), content: "# builtin" },
            })
          })

          const catalog = yield* SkillCatalog.Service
          const entries = yield* catalog.list()
          expect(entries).toHaveLength(1)
          expect(entries[0]!.target).toBeUndefined()
        }).pipe(Effect.provide(testLayer(tmp.path))).pipe(Effect.orDie)
      }),
    ),
  )
})
