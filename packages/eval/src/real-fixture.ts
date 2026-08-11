export * as RealFixture from "./real-fixture"

import { Effect } from "effect"
import { EvalGraph } from "./graph"
import type { CheckpointResult } from "./fixture"

/**
 * The real-model equivalent of Fixture.Fixture (fixture.ts) -- built against EvalGraph.RealHandle
 * (no FakeLLM.Instance to script or inspect) instead of EvalGraph.Handle. A real model decides
 * what to do on its own; a real fixture drives real turns and reads back real session state
 * (session.context, the event log) rather than scripting responses or inspecting composed
 * LLMRequests directly.
 */
export type Fixture = (handle: EvalGraph.RealHandle) => Effect.Effect<readonly CheckpointResult[], any, any>

/**
 * Real-model fixtures must never run in merge-gate CI (Ethan, TKT-319 ruling): they depend on an
 * external service (the LiteLLM gateway) being up, and an external-service dependency inside the
 * merge gate is how "green means green" dies its second death. Default OFF -- a caller opts in
 * explicitly with OPENCODE_EVAL_REAL=1, matching `dev/bin/litellm ensure_tunnel`'s own preflight
 * convention rather than inferring intent from gateway reachability alone.
 */
export const isEnabled = () => process.env.OPENCODE_EVAL_REAL === "1"

/** Builds a fresh real graph (real qwen3-6 via LiteLLM) and runs one fixture against it. Mirrors
 * Fixture.run's `any`-typed discharge (packages/core/test/lib/effect.ts's own Body<A,E,R>
 * pattern) -- a fixture's error/requirement types vary per scenario and are always discharged
 * here via Effect.provide(handle.layer), so precision at this boundary isn't load-bearing. */
export const run = (
  fixture: Fixture,
  input: { readonly databasePath: string; readonly model: import("@opencode-ai/llm").Model },
): Promise<readonly CheckpointResult[]> => {
  const handle = EvalGraph.buildReal({
    databasePath: input.databasePath,
    directory: EvalGraph.defaultDirectory,
    model: input.model,
  })
  const provided = fixture(handle).pipe(Effect.scoped, Effect.provide(handle.layer)) as Effect.Effect<
    readonly CheckpointResult[],
    unknown
  >
  return Effect.runPromise(provided)
}
