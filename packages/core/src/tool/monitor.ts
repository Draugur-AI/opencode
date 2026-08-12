export * as MonitorTool from "./monitor"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { Monitor as MonitorSchema } from "@opencode-ai/schema/monitor"
import { makeLocationNode } from "../effect/app-node"
import { Monitor } from "../monitor"
import { PermissionV2 } from "../permission"
import { PositiveInt } from "../schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const createName = "monitor_create"
export const listName = "monitor_list"

// Plugin sources and the plugin condition are excluded here even though the schema allows them:
// neither is executable (MonitorCondition.evaluate's "plugin" case always reports not-triggered,
// and runOne immediately fails any non-"command" source) -- exposing them would let the model
// declare a monitor that can only ever time out or never trigger. Restore both once plugin
// execution lands (diary 2435 §5's still-open failure taxonomy).
export const CreateInput = Schema.Struct({
  title: Schema.String,
  command: Schema.String,
  cwd: Schema.String.pipe(Schema.optional),
  intervalMs: PositiveInt,
  timeoutMs: PositiveInt,
  condition: Schema.Union([MonitorSchema.ExitCodeCondition, MonitorSchema.RegexCondition, MonitorSchema.JsonCondition]),
  maxAttempts: PositiveInt.pipe(Schema.optional),
  outputPolicy: Monitor.OutputPolicy.pipe(Schema.optional),
}).annotate({
  description:
    "Declare a command monitor: a shell command re-run on an interval, checked against a condition (exit code, regex, or JSON path) until it triggers or maxAttempts is reached. Runs unattended: if the command's permission is configured to ask for approval rather than allow, checks are refused (not silently skipped) until it is set to allow -- monitors cannot prompt for approval (TKT-392).",
})
export const CreateOutput = Schema.Struct({ monitor: Monitor.Info })
export type CreateOutput = typeof CreateOutput.Type

export const ListInput = Schema.Struct({})
export const ListOutput = Schema.Struct({ monitors: Schema.Array(Monitor.Info) })
export type ListOutput = typeof ListOutput.Type

// MonitorRuntime is deliberately NOT a dependency here. Wiring the real MonitorRuntime reachable
// from a location-scoped tool risks a genuine LayerNode compile cycle (locationServices ->
// BuiltInTools -> this tool -> MonitorRuntime -> LocationServiceMap.Service -> locationServices,
// since MonitorRuntime needs to resolve an ARBITRARY monitor's own session's location at check
// time, not just the one location this tool itself runs under) -- under design review (Henry).
// Until that lands, this tool only declares (Monitor.Service.create); nothing executes a declared
// monitor's checks yet, and there is no cancel here because MonitorRuntime.cancel is the only way
// to move a monitor out of "starting" -- shipping a cancel tool with nothing to cancel would be
// the half-finished implementation CLAUDE.md says not to ship.
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const monitor = yield* Monitor.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [createName]: Tool.make({
          description:
            "Declare a command monitor: a shell command re-run on an interval, checked against a condition (exit code, regex, or JSON path) until it triggers or maxAttempts is reached. Runs unattended: if the command's permission is configured to ask for approval rather than allow, checks are refused (not silently skipped) until it is set to allow -- monitors cannot prompt for approval (TKT-392).",
          input: CreateInput,
          output: CreateOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output.monitor, null, 2) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: createName,
                resources: ["*"],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const info = yield* monitor.create({
                sessionID: context.sessionID,
                title: input.title,
                source: { type: "command", command: input.command, cwd: input.cwd },
                intervalMs: input.intervalMs,
                timeoutMs: input.timeoutMs,
                condition: input.condition,
                maxAttempts: input.maxAttempts,
                outputPolicy: input.outputPolicy ?? {},
              })
              return { monitor: info }
            }).pipe(
              Effect.mapError((error) => (error instanceof ToolFailure ? error : new ToolFailure({ message: "Unable to create monitor" }))),
            ),
        }),
        [listName]: Tool.make({
          description: "List monitors declared in this session, with their current status.",
          input: ListInput,
          output: ListOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output.monitors, null, 2) }],
          execute: (_input, context) =>
            Effect.gen(function* () {
              const monitors = yield* monitor.list(context.sessionID)
              return { monitors }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/monitor",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, Monitor.node],
})
