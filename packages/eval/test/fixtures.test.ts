import { describe, expect, test } from "bun:test"
import { Fixture } from "../src/fixture"
import { OmittedIdentifierFixture } from "../src/fixtures/omitted-identifier"
import { ConstraintSurvivalFixture } from "../src/fixtures/constraint-survival"
import { tmpdir } from "./lib/tmpdir"

describe("fixtures run through EvalGraph in both modes", () => {
  test("omitted-identifier: real mode passes every checkpoint", async () => {
    const checkpoints = await Fixture.run(OmittedIdentifierFixture.run, {
      databasePath: `${tmpdir()}/eval.db`,
      mode: "real",
    })
    expect(checkpoints.length).toBeGreaterThan(0)
    for (const checkpoint of checkpoints) expect(checkpoint.pass).toBe(true)
  })

  test("constraint-survival: real mode keeps the constraint present across every compaction epoch", async () => {
    const checkpoints = await Fixture.run(ConstraintSurvivalFixture.run, {
      databasePath: `${tmpdir()}/eval.db`,
      mode: "real",
    })
    expect(checkpoints.length).toBe(4)
    for (const checkpoint of checkpoints) expect(checkpoint.pass).toBe(true)
  })

  test("constraint-survival: B-mode approximation fails every checkpoint (the constraint never appears)", async () => {
    const checkpoints = await Fixture.run(ConstraintSurvivalFixture.run, {
      databasePath: `${tmpdir()}/eval.db`,
      mode: "pre-slice-4-approximation",
    })
    for (const checkpoint of checkpoints) expect(checkpoint.pass).toBe(false)
  })
})
