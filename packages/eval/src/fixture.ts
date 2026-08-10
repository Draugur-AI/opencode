export * as Fixture from "./fixture"

import { Effect } from "effect"
import { EvalGraph } from "./graph"
import type { ContextAccounting } from "./context-accounting"

export interface CheckpointResult {
  readonly name: string
  readonly pass: boolean
  readonly detail?: string
  readonly accounting?: ContextAccounting.Breakdown
}

export interface Result {
  readonly fixture: string
  readonly mode: "real" | "pre-slice-4-approximation"
  readonly checkpoints: readonly CheckpointResult[]
}

/**
 * A fixture is a self-contained scenario: given a fresh graph handle and session, drive turns
 * and checkpoints, and return the scored results. Fixtures are plain functions (not a declarative
 * DSL) so the same Effect/FakeLLM primitives every other harness piece already uses work here
 * too -- no second scripting language to keep in sync with the runner's real behavior.
 */
// `any` here mirrors packages/core/test/lib/effect.ts's own Body<A,E,R>: a fixture's error and
// requirement types vary per scenario, and every fixture is always run via `Fixture.run` below,
// which discharges them with Effect.provide(handle.layer) -- the precise types aren't load-bearing
// at this boundary the way they are inside a fixture's own implementation.
export type Fixture = (handle: EvalGraph.Handle) => Effect.Effect<readonly CheckpointResult[], any, any>

export const check = (name: string, pass: boolean, detail?: string): CheckpointResult => ({ name, pass, detail })

/** Builds a fresh graph (real, or B-mode if `mode` says so) and runs one fixture against it. */
export const run = (
  fixture: Fixture,
  input: { readonly databasePath: string; readonly mode: "real" | "pre-slice-4-approximation" },
): Promise<readonly CheckpointResult[]> => {
  const handle = EvalGraph.build({
    databasePath: input.databasePath,
    directory: EvalGraph.defaultDirectory,
    overrides: input.mode === "pre-slice-4-approximation" ? EvalGraph.preSlice4Overrides : undefined,
  })
  const provided = fixture(handle).pipe(Effect.scoped, Effect.provide(handle.layer)) as Effect.Effect<
    readonly CheckpointResult[],
    unknown
  >
  return Effect.runPromise(provided)
}
