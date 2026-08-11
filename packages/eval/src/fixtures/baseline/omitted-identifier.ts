export * as BaselineOmittedIdentifierFixture from "./omitted-identifier"

import { Fixture } from "../../fixture"
import { BaselineGraph } from "../../baseline-graph"
import { OmittedIdentifierScenario } from "../../scenarios/omitted-identifier"
import { BaselineFixture } from "../../baseline-fixture"

const { IDENTIFIER } = OmittedIdentifierScenario

/**
 * The baseline-arm counterpart of fixtures/omitted-identifier.ts. Scripted (FakeHttpLLM), so it
 * cannot prove what a real model would say on recall -- that is task 19 (real qwen3-6). What it
 * DOES prove, against the real pre-slice-4 binary: the identifier's originating message survives
 * only until the real compaction pipeline moves the tail past it, and baseline has no side
 * channel (no goal/ledger/history_search) to recover it once that happens -- unlike the current
 * arm, there is no injected summary to control here, the compaction call is real end to end.
 */
export const run: BaselineFixture.Fixture = async (handle) => {
  const sessionID = await handle.createSession()

  handle.llm.push("Noted the connection details.")
  await handle.sendMessage(sessionID, OmittedIdentifierScenario.initialPrompt)

  const { compacted, turns } = await BaselineGraph.driveUntilCompaction(handle, sessionID)
  if (!compacted) {
    return [Fixture.check("real compaction fires within the turn budget", false, `no compaction after ${turns} filler turns`)]
  }

  handle.llm.push("Sure, continuing.")
  await handle.sendMessage(sessionID, OmittedIdentifierScenario.recallPrompt)

  // Literal fact, not an assertion of correctness -- baseline is EXPECTED to lose this (that is
  // the whole point of the comparison), so the caller decides what value is "good" for this arm.
  const lastRequest = handle.llm.requests.at(-1)
  const reachable = lastRequest ? JSON.stringify(lastRequest.body).includes(IDENTIFIER) : false

  return [
    Fixture.check("real compaction fires within the turn budget", true, `after ${turns} filler turns`),
    Fixture.check("the identifier is reachable in the composed context after compaction", reachable),
  ]
}
