import { Effect, Schema } from "effect"
import { Monitor as MonitorSchema } from "@opencode-ai/schema/monitor"
import { Monitor } from "@opencode-ai/core/monitor"
import { PositiveInt } from "@opencode-ai/core/schema"
import * as Tool from "./tool"

// V1 bridge for the V2 Monitor tools (packages/core/src/tool/monitor.ts): the live serving
// path is this legacy registry (see registry.ts's builtin list), which the V2 registration in
// core/tool/builtins.ts never reaches -- feedback #205, Sean's live gate walk. Delegates to the
// same Monitor.Service the V2 tool uses; no duplicated monitor logic, only the tool-shape bridge.
//
// Plugin sources and the plugin condition are excluded, mirroring the V2 tool: neither is
// executable yet (MonitorCondition.evaluate's "plugin" case always reports not-triggered).
export const CreateParameters = Schema.Struct({
  title: Schema.String,
  command: Schema.String,
  cwd: Schema.String.pipe(Schema.optional),
  intervalMs: PositiveInt,
  timeoutMs: PositiveInt,
  condition: Schema.Union([MonitorSchema.ExitCodeCondition, MonitorSchema.RegexCondition, MonitorSchema.JsonCondition]),
  maxAttempts: PositiveInt.pipe(Schema.optional),
  outputPolicy: MonitorSchema.OutputPolicy.pipe(Schema.optional),
}).annotate({
  description:
    "Declare a command monitor: a shell command re-run on an interval, checked against a condition (exit code, regex, or JSON path) until it triggers or maxAttempts is reached. Runs unattended: if the command's permission is configured to ask for approval rather than allow, checks are refused (not silently skipped) until it is set to allow -- monitors cannot prompt for approval.",
})

export const MonitorCreateTool = Tool.define(
  "monitor_create",
  Effect.gen(function* () {
    const monitor = yield* Monitor.Service

    return {
      description:
        "Declare a command monitor: a shell command re-run on an interval, checked against a condition (exit code, regex, or JSON path) until it triggers or maxAttempts is reached. Runs unattended: if the command's permission is configured to ask for approval rather than allow, checks are refused (not silently skipped) until it is set to allow -- monitors cannot prompt for approval.",
      parameters: CreateParameters,
      execute: (params: Schema.Schema.Type<typeof CreateParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "monitor_create",
            patterns: ["*"],
            always: ["*"],
            metadata: { command: params.command },
          })
          const info = yield* monitor.create({
            sessionID: ctx.sessionID,
            title: params.title,
            source: { type: "command", command: params.command, cwd: params.cwd },
            intervalMs: params.intervalMs,
            timeoutMs: params.timeoutMs,
            condition: params.condition,
            maxAttempts: params.maxAttempts,
            outputPolicy: params.outputPolicy ?? {},
          })
          return {
            title: `Monitor declared: ${info.title}`,
            output: JSON.stringify({ monitor: info }, null, 2),
            metadata: { monitorID: info.id },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const MonitorListParameters = Schema.Struct({})

export const MonitorListTool = Tool.define(
  "monitor_list",
  Effect.gen(function* () {
    const monitor = yield* Monitor.Service

    return {
      description: "List monitors declared in this session, with their current status.",
      parameters: MonitorListParameters,
      execute: (_params: Schema.Schema.Type<typeof MonitorListParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const monitors = yield* monitor.list(ctx.sessionID)
          return {
            title: `${monitors.length} monitor${monitors.length === 1 ? "" : "s"}`,
            output: JSON.stringify({ monitors }, null, 2),
            metadata: { count: monitors.length },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
