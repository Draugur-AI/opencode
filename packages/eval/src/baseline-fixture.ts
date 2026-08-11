export * as BaselineFixture from "./baseline-fixture"

import { $ } from "bun"
import { BaselineGraph } from "./baseline-graph"
import type { CheckpointResult } from "./fixture"

/**
 * The baseline-arm equivalent of Fixture.Fixture (fixture.ts) -- plain async instead of Effect,
 * since BaselineGraph.Handle drives a real subprocess over real HTTP rather than an in-process
 * Effect layer graph, so there is nothing here for Effect.provide to discharge.
 */
export type Fixture = (handle: BaselineGraph.Handle) => Promise<readonly CheckpointResult[]>

/** Builds a fresh baseline graph (real subprocess + fake HTTP LLM) and runs one fixture against
 * it, always tearing the subprocess down afterward even if the fixture throws. */
export const run = async (fixture: Fixture): Promise<readonly CheckpointResult[]> => {
  const repoRoot = (await $`git rev-parse --show-toplevel`.cwd(import.meta.dir).quiet().text()).trim()
  const handle = await BaselineGraph.build({ repoRoot })
  try {
    return await fixture(handle)
  } finally {
    await handle.stop()
  }
}
