export * as Report from "./report"

import type { Fixture } from "./fixture"

export interface FixtureReport {
  readonly name: string
  readonly mode: "real" | "pre-slice-4-approximation"
  readonly checkpoints: readonly Fixture.CheckpointResult[]
}

export const render = (reports: readonly FixtureReport[]): string => {
  const lines: string[] = []
  let totalPass = 0
  let totalFail = 0

  for (const report of reports) {
    const label = report.mode === "pre-slice-4-approximation" ? `${report.name} [deterministic-approximation, B-mode]` : report.name
    lines.push(`## ${label}`)
    for (const checkpoint of report.checkpoints) {
      const mark = checkpoint.pass ? "PASS" : "FAIL"
      if (checkpoint.pass) totalPass++
      else totalFail++
      lines.push(`  [${mark}] ${checkpoint.name}${checkpoint.detail ? ` -- ${checkpoint.detail}` : ""}`)
      if (checkpoint.accounting) {
        const a = checkpoint.accounting
        lines.push(
          `         tokens: goal=${a.goal.tokens} ledger=${a.ledger.tokens} otherSystem=${a.otherSystem.tokens} tail=${a.tail.tokens} tools=${a.tools.tokens} total=${a.total.tokens}`,
        )
      }
    }
    lines.push("")
  }

  lines.push(`${totalPass} pass, ${totalFail} fail across ${reports.length} fixture run(s)`)
  lines.push("")
  lines.push(
    "NOTE: this is the scripted-model gate report only. Anything not marked",
    "[deterministic-approximation, B-mode] ran against the CURRENT implementation with a",
    "scripted model, not a baseline binary and not a real model -- it proves the harness and the",
    "real compaction pipeline, not model behavior. Mode A (real pre-slice-4 binary, real",
    "qwen3-6) shipped in PR2 (baseline-arm structural proof) and PR3 (real-model findings,",
    "gated behind OPENCODE_EVAL_REAL=1) -- see TKT-319's diary for the release-facing summary,",
    "not this CLI, which only ever exercises the scripted arms.",
  )

  return lines.join("\n")
}
