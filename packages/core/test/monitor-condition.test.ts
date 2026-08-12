import { describe, expect, test } from "bun:test"
import { MonitorCondition } from "@opencode-ai/core/monitor/condition"

describe("MonitorCondition.evaluate", () => {
  test("exit-code: triggers when the exit code matches", () => {
    const result = MonitorCondition.evaluate({ type: "exit-code", expect: 0 }, { exitCode: 0, output: "" })
    expect(result.triggered).toBe(true)
  })

  test("exit-code: does not trigger on a mismatch", () => {
    const result = MonitorCondition.evaluate({ type: "exit-code", expect: 0 }, { exitCode: 1, output: "" })
    expect(result.triggered).toBe(false)
  })

  test("regex: triggers on a match anywhere in the output", () => {
    const result = MonitorCondition.evaluate(
      { type: "regex", pattern: "ERROR: \\w+" },
      { exitCode: 0, output: "line one\nERROR: disk_full\nline three" },
    )
    expect(result.triggered).toBe(true)
    expect(result.detail).toContain("ERROR: disk_full")
  })

  test("regex: does not trigger without a match", () => {
    const result = MonitorCondition.evaluate({ type: "regex", pattern: "ERROR" }, { exitCode: 0, output: "all fine" })
    expect(result.triggered).toBe(false)
  })

  test("regex: an invalid pattern reports not-triggered rather than throwing", () => {
    const result = MonitorCondition.evaluate({ type: "regex", pattern: "(unclosed" }, { exitCode: 0, output: "x" })
    expect(result.triggered).toBe(false)
    expect(result.detail).toContain("invalid regex")
  })

  test("json: triggers when the value at path matches expect", () => {
    const result = MonitorCondition.evaluate(
      { type: "json", path: "status.ready", expect: true },
      { exitCode: 0, output: JSON.stringify({ status: { ready: true } }) },
    )
    expect(result.triggered).toBe(true)
  })

  test("json: does not trigger when the value differs", () => {
    const result = MonitorCondition.evaluate(
      { type: "json", path: "status.ready", expect: true },
      { exitCode: 0, output: JSON.stringify({ status: { ready: false } }) },
    )
    expect(result.triggered).toBe(false)
  })

  test("json: invalid JSON output reports not-triggered rather than throwing", () => {
    const result = MonitorCondition.evaluate(
      { type: "json", path: "status", expect: true },
      { exitCode: 0, output: "not json" },
    )
    expect(result.triggered).toBe(false)
    expect(result.detail).toContain("not valid JSON")
  })

  test("plugin: reports not-triggered -- plugin conditions are not executable in this slice", () => {
    const result = MonitorCondition.evaluate({ type: "plugin" }, { exitCode: 0, output: "anything" })
    expect(result.triggered).toBe(false)
  })
})
