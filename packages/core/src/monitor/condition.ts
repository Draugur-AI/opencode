export * as MonitorCondition from "./condition"

import type { Monitor } from "@opencode-ai/schema/monitor"

export type Result = {
  readonly triggered: boolean
  readonly detail: string
}

const path = (value: unknown, pointer: string): unknown => {
  if (pointer === "") return value
  return pointer.split(".").reduce<unknown>((current, key) => {
    if (current === undefined || current === null) return undefined
    if (typeof current !== "object") return undefined
    return (current as Record<string, unknown>)[key]
  }, value)
}

const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (typeof a !== "object" || a === null || b === null) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Deterministic, no I/O -- exit-code/regex/JSON conditions are pure functions of a completed
 * check's exit code and captured output. Plugin conditions are execution-phase but out of scope
 * for this slice (diary 2435 §5: plugin monitors' failure taxonomy is a separate open question);
 * evaluating one here always reports not-triggered rather than pretending to run a plugin.
 */
export const evaluate = (condition: Monitor.Condition, result: { readonly exitCode: number; readonly output: string }): Result => {
  switch (condition.type) {
    case "exit-code":
      return {
        triggered: result.exitCode === condition.expect,
        detail: `exit code ${result.exitCode} (expected ${condition.expect})`,
      }
    case "regex": {
      let regex: RegExp
      try {
        regex = new RegExp(condition.pattern, condition.flags)
      } catch (error) {
        return { triggered: false, detail: `invalid regex: ${error instanceof Error ? error.message : String(error)}` }
      }
      const match = regex.exec(result.output)
      return { triggered: match !== null, detail: match ? `matched "${match[0]}"` : "no match" }
    }
    case "json": {
      let parsed: unknown
      try {
        parsed = JSON.parse(result.output)
      } catch {
        return { triggered: false, detail: "output is not valid JSON" }
      }
      const value = path(parsed, condition.path)
      return { triggered: equal(value, condition.expect), detail: `${condition.path} = ${JSON.stringify(value)}` }
    }
    case "plugin":
      return { triggered: false, detail: "plugin conditions are not executable in this slice" }
  }
}
