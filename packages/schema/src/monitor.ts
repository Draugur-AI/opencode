export * as Monitor from "./monitor"

import { Schema } from "effect"
import { DateTimeUtcFromMillis, NonNegativeInt, optional, statics } from "./schema"
import { ascending } from "./identifier"
import { SessionID } from "./session-id"
import { SessionProfile } from "./session-profile"

export const ID = Schema.String.check(Schema.isStartsWith("mon_")).pipe(
  Schema.brand("Monitor.ID"),
  statics((schema) => ({ create: () => schema.make("mon_" + ascending()) })),
)
export type ID = typeof ID.Type

// One row per check attempt (packages/core/src/monitor/sql.ts's monitor_check table) -- bounded,
// prunable, keyed, matching session_lifecycle_request's shape (diary 2435 §1's table).
export const CheckID = Schema.String.check(Schema.isStartsWith("mck_")).pipe(
  Schema.brand("Monitor.CheckID"),
  statics((schema) => ({ create: () => schema.make("mck_" + ascending()) })),
)
export type CheckID = typeof CheckID.Type

// Declaration + current status live in the `monitor` row (packages/core/src/monitor/sql.ts).
// TKT-322 design note diary 2435 §1: this is the split the build post asks for -- declaration and
// status here, bounded per-check records in `monitor_check`, full output in managed storage, live
// process ownership in the (execution-phase) MonitorRuntime port. This schema module covers only
// the first of those; `monitor/condition.ts`'s evaluators and `monitor/process.ts`'s live
// ownership are execution-phase and do not exist yet (TKT-322 PR1 is declaration + recovery only,
// no execution -- see FORK.md's divergence ledger).
export const Status = Schema.Literals([
  "starting",
  "running",
  "triggered",
  "completed",
  "failed",
  "cancelled",
  "orphaned",
]).annotate({ identifier: "Monitor.Status" })
export type Status = typeof Status.Type

export const CommandSource = Schema.Struct({
  type: Schema.Literal("command"),
  command: Schema.String,
  cwd: Schema.String.pipe(optional),
}).annotate({ identifier: "Monitor.CommandSource" })
export type CommandSource = typeof CommandSource.Type

export const PluginMonitorSource = Schema.Struct({
  type: Schema.Literal("plugin"),
  pluginID: Schema.String,
  input: Schema.Record(Schema.String, Schema.Unknown).pipe(optional),
}).annotate({ identifier: "Monitor.PluginMonitorSource" })
export type PluginMonitorSource = typeof PluginMonitorSource.Type

export const Source = Schema.Union([CommandSource, PluginMonitorSource]).annotate({
  identifier: "Monitor.Source",
})
export type Source = typeof Source.Type

// Declarative only -- the evaluators that actually test output against one of these are
// execution-phase (monitor/condition.ts), not built in this slice.
export const ExitCodeCondition = Schema.Struct({
  type: Schema.Literal("exit-code"),
  expect: Schema.Int,
}).annotate({ identifier: "Monitor.ExitCodeCondition" })

export const RegexCondition = Schema.Struct({
  type: Schema.Literal("regex"),
  pattern: Schema.String,
  flags: Schema.String.pipe(optional),
}).annotate({ identifier: "Monitor.RegexCondition" })

export const JsonCondition = Schema.Struct({
  type: Schema.Literal("json"),
  path: Schema.String,
  expect: Schema.Unknown,
}).annotate({ identifier: "Monitor.JsonCondition" })

export const PluginCondition = Schema.Struct({
  type: Schema.Literal("plugin"),
}).annotate({ identifier: "Monitor.PluginCondition" })

export const Condition = Schema.Union([ExitCodeCondition, RegexCondition, JsonCondition, PluginCondition]).annotate({
  identifier: "Monitor.Condition",
})
export type Condition = typeof Condition.Type

// Bounds applied before persistence (monitor/output.ts, execution-phase); declared here because
// they are part of what the user configures at declaration time.
export const OutputPolicy = Schema.Struct({
  maxLines: NonNegativeInt.pipe(optional),
  maxBytes: NonNegativeInt.pipe(optional),
  redactPatterns: Schema.Array(Schema.String).pipe(optional),
}).annotate({ identifier: "Monitor.OutputPolicy" })
export type OutputPolicy = typeof OutputPolicy.Type

// A process ID is diagnostic metadata, never proof a monitor is alive after restart (design post;
// TKT-322 diary 2435 §1 states this as a test, not a comment: recovery must never read this field
// to decide liveness -- see packages/core/test/monitor/recover.test.ts).
export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  title: Schema.String,
  source: Source,
  intervalMs: NonNegativeInt,
  timeoutMs: NonNegativeInt,
  condition: Condition,
  status: Status,
  attempt: NonNegativeInt,
  maxAttempts: NonNegativeInt.pipe(optional),
  outputPolicy: OutputPolicy,
  profileSnapshotID: SessionProfile.SnapshotID.pipe(optional),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    started: DateTimeUtcFromMillis.pipe(optional),
    checked: DateTimeUtcFromMillis.pipe(optional),
    finished: DateTimeUtcFromMillis.pipe(optional),
  }),
  revision: NonNegativeInt,
}).annotate({ identifier: "Monitor.Info" })
