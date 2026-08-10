#!/usr/bin/env bun
import { fileURLToPath } from "url"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Fixture } from "../src/fixture"
import { Report } from "../src/report"
import { OmittedIdentifierFixture } from "../src/fixtures/omitted-identifier"
import { ConstraintSurvivalFixture } from "../src/fixtures/constraint-survival"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "opencode-eval-"))

const fixtures = [
  { name: "omitted-identifier-recovery", run: OmittedIdentifierFixture.run },
  { name: "constraint-survival", run: ConstraintSurvivalFixture.run },
]

const main = async () => {
  const reports: Report.FixtureReport[] = []
  for (const fixture of fixtures) {
    const checkpoints = await Fixture.run(fixture.run, { databasePath: `${tmpdir()}/eval.db`, mode: "real" })
    reports.push({ name: fixture.name, mode: "real", checkpoints })
  }
  // The B-mode approximation run exists to validate the toggle itself is meaningful (a run that
  // "passes" identically in both modes would mean the fixture isn't testing slice-4/5 at all) --
  // not every fixture needs it, but constraint-survival is the one built to show the delta.
  const bModeCheckpoints = await Fixture.run(ConstraintSurvivalFixture.run, {
    databasePath: `${tmpdir()}/eval.db`,
    mode: "pre-slice-4-approximation",
  })
  reports.push({ name: "constraint-survival", mode: "pre-slice-4-approximation", checkpoints: bModeCheckpoints })

  console.log(Report.render(reports))

  const anyFail = reports.some((report) => report.mode === "real" && report.checkpoints.some((c) => !c.pass))
  if (anyFail) process.exit(1)
}

await main()
