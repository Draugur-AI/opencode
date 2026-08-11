import { describe, expect, test } from "bun:test"
import { BaselineFixture } from "../src/baseline-fixture"
import { BaselineOmittedIdentifierFixture } from "../src/fixtures/baseline/omitted-identifier"
import { BaselineConstraintSurvivalFixture } from "../src/fixtures/baseline/constraint-survival"

/**
 * Checkpoints report literal facts ("did compaction fire", "is X reachable"), not per-arm
 * correctness -- reachability is EXPECTED to be false for baseline (it has no durable side
 * channel), the same way the current arm's B-mode approximation test expects every checkpoint to
 * fail. Structural checkpoints (did the real pipeline actually run) are expected true regardless.
 */
const expectPass = (name: string) => name.startsWith("real compaction fires")

describe("baseline-arm fixtures run against the real pre-slice-4 binary", () => {
  test(
    "omitted-identifier: real compaction fires and drops the identifier's originating message",
    async () => {
      const checkpoints = await BaselineFixture.run(BaselineOmittedIdentifierFixture.run)
      expect(checkpoints.length).toBeGreaterThan(0)
      for (const checkpoint of checkpoints) expect(checkpoint.pass).toBe(expectPass(checkpoint.name))
    },
    120_000,
  )

  test(
    "constraint-survival: every epoch's real compaction drops the constraint (no durable side channel)",
    async () => {
      const checkpoints = await BaselineFixture.run(BaselineConstraintSurvivalFixture.run)
      expect(checkpoints.length).toBeGreaterThan(0)
      for (const checkpoint of checkpoints) expect(checkpoint.pass).toBe(expectPass(checkpoint.name))
    },
    180_000,
  )
})
