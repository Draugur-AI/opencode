import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillDiscovery } from "@opencode-ai/core/skill/discovery"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const urls = new Map<string, AbsolutePath[]>()
let pulls = 0
const discovery = Layer.succeed(
  SkillDiscovery.Service,
  SkillDiscovery.Service.of({
    pull: (url) => {
      pulls++
      return Effect.succeed(urls.get(url) ?? [])
    },
  }),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([SkillV2.node, AgentV2.node]), [[SkillDiscovery.node, discovery]]),
)

function write(directory: string, name: string, description: string) {
  return fs.writeFile(
    path.join(directory, name, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---
# ${name}`,
  )
}

describe("SkillV2", () => {
  it.live("registers sources and resolves later source precedence", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const first = path.join(tmp.path, "first")
          const second = path.join(tmp.path, "second")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(first, "review"), { recursive: true })
            await fs.mkdir(path.join(second, "review"), { recursive: true })
            await write(first, "review", "First")
            await write(second, "review", "Second")
            await fs.writeFile(path.join(first, "foo.md"), "---\nslash: true\n---\n# foo")
          })

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => {
            editor.source({ type: "directory", path: AbsolutePath.make(first) })
            editor.source({ type: "directory", path: AbsolutePath.make(first) })
            editor.source({ type: "directory", path: AbsolutePath.make(second) })
            expect(editor.list()).toEqual([
              { type: "directory", path: AbsolutePath.make(first) },
              { type: "directory", path: AbsolutePath.make(second) },
            ])
          })

          expect(yield* skill.sources()).toEqual([
            { type: "directory", path: AbsolutePath.make(first) },
            { type: "directory", path: AbsolutePath.make(second) },
          ])
          expect(yield* skill.list()).toEqual([
            SkillV2.Info.make({
              name: "foo",
              slash: true,
              location: AbsolutePath.make(path.join(first, "foo.md")),
              content: "# foo",
            }),
            {
              name: "review",
              description: "Second",
              location: AbsolutePath.make(path.join(second, "review", "SKILL.md")),
              content: "# review",
            },
          ])
        }),
      ),
    ),
  )

  it.live("loads URL sources and filters skills for agents", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "deploy"), { recursive: true })
            await write(tmp.path, "deploy", "Deploy production")
          })
          pulls = 0
          urls.set("https://example.test/skills/", [AbsolutePath.make(tmp.path)])

          const agents = yield* AgentV2.Service
          yield* agents.transform((editor) =>
            editor.update(AgentV2.ID.make("reviewer"), (agent) => {
              agent.permissions.push({ action: "skill", resource: "deploy", effect: "deny" })
            }),
          )

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => editor.source({ type: "url", url: "https://example.test/skills/" }))

          expect((yield* skill.list()).map((item) => item.name)).toEqual(["deploy"])
          expect((yield* skill.list()).map((item) => item.name)).toEqual(["deploy"])
          expect(pulls).toBe(1)
          expect(SkillV2.available(yield* skill.list(), (yield* agents.get(AgentV2.ID.make("reviewer")))!)).toEqual([])
        }),
      ),
    ),
  )

  test("mergeSkills marks the winner and every shadowed loser, in registration order", () => {
    const first = SkillV2.Info.make({
      name: "review",
      description: "First",
      location: AbsolutePath.make("/first/review/SKILL.md"),
      content: "# review",
    })
    const second = SkillV2.Info.make({
      name: "review",
      description: "Second",
      location: AbsolutePath.make("/second/review/SKILL.md"),
      content: "# review",
    })
    const solo = SkillV2.Info.make({
      name: "solo",
      location: AbsolutePath.make("/first/solo/SKILL.md"),
      content: "# solo",
    })
    const sourceA: SkillV2.Source = { type: "directory", path: AbsolutePath.make("/first") }
    const sourceB: SkillV2.Source = { type: "directory", path: AbsolutePath.make("/second") }

    const entries = SkillV2.mergeSkills([
      { source: sourceA, skills: [first, solo] },
      { source: sourceB, skills: [second] },
    ])

    expect(entries).toEqual([
      { skill: first, source: sourceA, sourceIndex: 0, shadowedBy: { source: sourceB, sourceIndex: 1 } },
      { skill: solo, source: sourceA, sourceIndex: 0 },
      { skill: second, source: sourceB, sourceIndex: 1 },
    ])
  })

  test("mergeSkills: perturbing registration order moves the winner -- proof it's the same ordering list() uses", () => {
    const first = SkillV2.Info.make({
      name: "review",
      description: "First",
      location: AbsolutePath.make("/first/review/SKILL.md"),
      content: "# review",
    })
    const second = SkillV2.Info.make({
      name: "review",
      description: "Second",
      location: AbsolutePath.make("/second/review/SKILL.md"),
      content: "# review",
    })
    const sourceA: SkillV2.Source = { type: "directory", path: AbsolutePath.make("/first") }
    const sourceB: SkillV2.Source = { type: "directory", path: AbsolutePath.make("/second") }

    const normal = SkillV2.mergeSkills([
      { source: sourceA, skills: [first] },
      { source: sourceB, skills: [second] },
    ])
    expect(normal.find((entry) => !entry.shadowedBy)?.skill.description).toBe("Second")

    // Same two sources, registration order reversed -- the winner must flip, exactly as it would
    // if the sources array feeding list() were reordered. This is the "both surfaces move
    // together" property: there is no second ordering to keep in sync, because there is only one.
    const reversed = SkillV2.mergeSkills([
      { source: sourceB, skills: [second] },
      { source: sourceA, skills: [first] },
    ])
    expect(reversed.find((entry) => !entry.shadowedBy)?.skill.description).toBe("First")
  })
})
