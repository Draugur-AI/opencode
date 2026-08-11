export * as RealBaselineOmittedIdentifierFixture from "./baseline-omitted-identifier"

import { Fixture } from "../../fixture"
import { BaselineGraph } from "../../baseline-graph"
import { OmittedIdentifierScenario } from "../../scenarios/omitted-identifier"
import { BaselineFixture } from "../../baseline-fixture"

const { IDENTIFIER } = OmittedIdentifierScenario

/**
 * The real-model counterpart of fixtures/baseline/omitted-identifier.ts -- same real pre-slice-4
 * binary, same real compaction pipeline, but a real qwen3-6 reply on the recall turn instead of
 * an empty scripted one. Scores the OUTCOME (does the reply's own text contain the identifier)
 * rather than the composed-request wire check the scripted fixture uses, since there is no
 * FakeHttpLLM here to capture requests from -- matching the design's stated baseline scoring:
 * "does it re-ask for information already given."
 */
export const run: BaselineFixture.Fixture = async (handle) => {
  const sessionID = await handle.createSession()

  await handle.sendMessage(sessionID, OmittedIdentifierScenario.initialPrompt)

  // Bigger, fewer turns than the scripted arm's default -- each real turn costs real wall-clock
  // against qwen3-6 (~15-20s observed), and buildReal's own context (8_000, vs the scripted
  // arm's 20_000) is sized to make this trip overflow.ts's real trigger within that budget.
  const { compacted, turns } = await BaselineGraph.driveUntilCompaction(handle, sessionID, { maxTurns: 4, fillerRepeat: 12_000 })
  if (!compacted) {
    return [Fixture.check("real compaction fires within the turn budget", false, `no compaction after ${turns} filler turns`)]
  }

  const reply = (await handle.sendMessage(sessionID, OmittedIdentifierScenario.recallPrompt)) as {
    parts?: ReadonlyArray<{ type: string; text?: string }>
  }
  const text = (reply.parts ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("")

  return [
    Fixture.check("real compaction fires within the turn budget", true, `after ${turns} filler turns`),
    Fixture.check("the reply recovers the identifier without a durable side channel", text.includes(IDENTIFIER), text),
  ]
}
