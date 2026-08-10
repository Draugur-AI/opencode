export * as EvalGraph from "./graph"

import { Database } from "@opencode-ai/core/database/database"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { EventV2 } from "@opencode-ai/core/event"
import { QuestionV2 } from "@opencode-ai/core/question"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { Location } from "@opencode-ai/core/location"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import * as SessionRunnerLLM from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionGoal } from "@opencode-ai/core/session/goal"
import { SessionLedger } from "@opencode-ai/core/session/ledger"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { SystemContext } from "@opencode-ai/core/system-context"
import { Model } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { Effect, Layer } from "effect"
import { FakeLLM } from "./fake-llm"

export const defaultDirectory = AbsolutePath.make("/project")

export const model = Model.make({ id: "eval-model", provider: "eval", route: OpenAIChat.route })

/**
 * A model whose context window is small enough that a normal-length eval conversation trips
 * SessionCompaction's real overflow check on its own -- the anchor fixture needs the REAL
 * compaction pipeline to run (not injected events), and shrinking the model is the established
 * way to get there deterministically (see packages/core/test/session-runner.test.ts's
 * `compactModel`), rather than trying to grow a fixture transcript to a real model's real limit.
 */
export const compactModel = Model.make({
  id: "eval-compact-model",
  provider: "eval",
  // The gap between "trigger" (context - buffer) and "the head still fits the summarizer call"
  // (context - summaryOutput) has to be wide enough that a real conversation can land in it --
  // too tight (e.g. a 4k window with a 500-token buffer) and the same growth that trips the
  // trigger also blows the summarizer's own input budget, so compaction silently never completes.
  route: OpenAIChat.route.with({ limits: { context: 20_000, output: 200 } }),
})

/**
 * B-mode: the fast dev-loop approximation of pre-slice-4 behavior. Assembly-time config, not a
 * code fork -- SessionGoal/SessionLedger stay wired into the graph and still accept writes (a
 * ledger_add tool call still succeeds), but their contribution to context is always empty, the
 * same shape `SystemContext.empty` already means for "nothing to say" throughout the codebase.
 * This is an approximation and must be labeled as such wherever its output is reported (Ethan,
 * TKT-319 ruling) -- see report.ts.
 */
export const preSlice4Overrides: LayerNode.Replacements = [
  [
    SessionGoal.node,
    Layer.mock(SessionGoal.Service, {
      context: () => Effect.succeed(SystemContext.empty),
    }),
  ],
  [
    SessionLedger.node,
    Layer.mock(SessionLedger.Service, {
      context: () => Effect.succeed(SystemContext.empty),
    }),
  ],
]

export interface Handle {
  readonly llm: FakeLLM.Instance
  readonly layer: Layer.Layer<
    | Database.Service
    | EventV2.Service
    | SessionV2.Service
    | SessionGoal.Service
    | SessionLedger.Service
  >
}

/**
 * Builds one V2 app graph: Database (at the given path, so a second `build` against the same
 * path is a restart-with-same-store, not a fresh instance) + event log + session runner + goal +
 * ledger + history search tools, wired to a fresh FakeLLM.Instance. `overrides` layers on top for
 * B-mode's goal/ledger empty-context substitution; pass none for the real (A-anchor) graph.
 */
export const build = (input: {
  readonly databasePath: string
  readonly directory: AbsolutePath
  readonly model?: Model
  readonly overrides?: LayerNode.Replacements
}): Handle => {
  const llm = FakeLLM.make()
  const selectedModel = input.model ?? model

  const permission = Layer.succeed(
    PermissionV2.Service,
    PermissionV2.Service.of({
      assert: () => Effect.void,
      ask: () => Effect.die("EvalGraph: interactive permission prompts are not scripted"),
      reply: () => Effect.die("EvalGraph: interactive permission prompts are not scripted"),
      get: () => Effect.die("EvalGraph: interactive permission prompts are not scripted"),
      forSession: () => Effect.succeed([]),
      list: () => Effect.succeed([]),
    }),
  )

  const skillGuidance = Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
  const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })

  const config = Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () =>
        Effect.succeed([
          new Config.Document({
            type: "document",
            info: new Config.Info({
              compaction: new ConfigCompaction.Info({
                // A wide gap between "trigger" (context - buffer) and "the head still fits the
                // summarizer's own call" (context - output) -- checks only run once per turn, so
                // a narrow gap can be entirely eaten by one turn's growth plus buildPrompt's own
                // wrapping overhead, and compaction never actually completes. See compactModel's
                // comment in this file for the fuller explanation.
                buffer: 6_000,
                keep: new ConfigCompaction.Keep({ tokens: 500 }),
              }),
            }),
          }),
        ]),
    }),
  )

  const models = SessionRunnerModel.layerWith(() => Effect.succeed(selectedModel))

  const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
    [Snapshot.node, Snapshot.noopLayer],
    [LayerNodePlatform.llmClient, llm.layer],
    [SessionRunnerModel.node, models],
    [Location.node, Location.boundNode({ directory: input.directory })],
    [SkillGuidance.node, skillGuidance],
    [ReferenceGuidance.node, referenceGuidance],
    [PermissionV2.node, permission],
    [Config.node, config],
  ])

  const execution = Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const sessionRunner = yield* SessionRunner.Service
      const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, SessionRunner.RunError>({
        drain: (sessionID, force) => sessionRunner.run({ sessionID, force }),
      })
      return SessionExecution.Service.of({
        active: coordinator.active,
        resume: coordinator.run,
        wake: coordinator.wake,
        interrupt: coordinator.interrupt,
      })
    }),
  ).pipe(Layer.provide(runnerLayer))

  const layer = AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      QuestionV2.node,
      SessionProjector.node,
      SessionStore.node,
      ApplicationTools.node,
      AgentV2.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      SessionRunnerModel.node,
      SystemContextRegistry.node,
      SkillGuidance.node,
      ReferenceGuidance.node,
      Config.node,
      Snapshot.node,
      SessionRunnerLLM.node,
      SessionExecution.node,
      SessionV2.node,
    ]),
    [
      [Database.node, Database.layerFromPath(input.databasePath)],
      [LayerNodePlatform.llmClient, llm.layer],
      [PermissionV2.node, permission],
      [SessionRunnerModel.node, models],
      [Location.node, Location.boundNode({ directory: input.directory })],
      [SkillGuidance.node, skillGuidance],
      [ReferenceGuidance.node, referenceGuidance],
      [Snapshot.node, Snapshot.noopLayer],
      [SessionExecution.node, execution],
      [Config.node, config],
      ...(input.overrides ?? []),
    ],
  ) as Handle["layer"]

  return { llm, layer }
}

export const insertProject = Effect.fn("EvalGraph.insertProject")(function* (directory: AbsolutePath) {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})
