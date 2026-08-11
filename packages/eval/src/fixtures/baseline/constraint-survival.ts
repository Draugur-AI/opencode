export * as BaselineConstraintSurvivalFixture from "./constraint-survival"

import { Fixture } from "../../fixture"
import { BaselineGraph } from "../../baseline-graph"
import { ConstraintSurvivalScenario } from "../../scenarios/constraint-survival"
import { BaselineFixture } from "../../baseline-fixture"

const { CONSTRAINT_TEXT, EPOCHS } = ConstraintSurvivalScenario

/**
 * The baseline-arm counterpart of fixtures/constraint-survival.ts. Baseline has no
 * SessionGoal/SessionEvent.GoalUpdated durable side channel, so the constraint can only enter
 * through a normal user message (scenarios/constraint-survival.ts's baselineInitialPrompt) --
 * whatever happens to it after that is entirely up to the real compaction pipeline, same as
 * omitted-identifier's baseline fixture. Proves the necessary-not-sufficient half only (see that
 * fixture's current-arm counterpart's own comment) -- real refusal behavior needs a real model.
 */
export const run: BaselineFixture.Fixture = async (handle) => {
  const sessionID = await handle.createSession()

  handle.llm.push("Understood, starting cleanup.")
  await handle.sendMessage(sessionID, ConstraintSurvivalScenario.baselineInitialPrompt)

  const checkpoints: Fixture.CheckpointResult[] = []

  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    const { compacted, turns } = await BaselineGraph.driveUntilCompaction(handle, sessionID)
    checkpoints.push(
      Fixture.check(`real compaction fires during epoch ${epoch}`, compacted, compacted ? `after ${turns} filler turns` : `no compaction after ${turns} filler turns`),
    )
    if (!compacted) break

    handle.llm.push(`Continuing epoch ${epoch}.`)
    await handle.sendMessage(sessionID, ConstraintSurvivalScenario.turnPrompt(epoch))

    // Literal fact, not an assertion of correctness -- see omitted-identifier's baseline
    // fixture for why the caller, not this checkpoint, decides what value is "good" here.
    const lastRequest = handle.llm.requests.at(-1)
    const reachable = lastRequest ? JSON.stringify(lastRequest.body).includes(CONSTRAINT_TEXT) : false
    checkpoints.push(Fixture.check(`constraint reachable in composed context after epoch ${epoch}`, reachable))
  }

  return checkpoints
}
