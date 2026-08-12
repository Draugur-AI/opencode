export * as MonitorEvent from "./monitor-event"

import { Schema } from "effect"
import { Event } from "./event"
import { DateTimeUtcFromMillis, NonNegativeInt, optional } from "./schema"
import { SessionID } from "./session-id"
import { Monitor } from "./monitor"

// Session-owned durable events, same convention as session-event.ts's "session.next.*" family, so
// the existing per-session replay endpoint delivers them in exact order (design post, "Monitor
// events are session-owned durable events"). `Checked` must stay sampled/coalesced -- persisting
// every check would repeat the event-growth mistake the tool-progress schema already avoids
// (session-event.ts's `Tool.Progress`, "checkpoint semantic transitions... not persist every
// stdout/stderr chunk").
//
// TKT-322 PR1 scope (schema + declaration + recovery, no execution): only `Created` and
// `Orphaned` are actually published by this slice, by `packages/core/src/monitor.ts`'s `create`
// and `recover`. The other five are declared now because they are part of the durable contract
// the design post specifies, but nothing publishes them until the execution-phase PR lands.

const Base = {
  timestamp: DateTimeUtcFromMillis,
  sessionID: SessionID,
  monitorID: Monitor.ID,
}
const options = {
  durable: {
    aggregate: "sessionID",
    version: 1,
  },
} as const

export const Created = Event.define({
  type: "session.next.monitor.created",
  ...options,
  schema: {
    ...Base,
    info: Monitor.Info,
  },
})
export type Created = typeof Created.Type

export const Started = Event.define({
  type: "session.next.monitor.started",
  ...options,
  schema: {
    ...Base,
  },
})
export type Started = typeof Started.Type

// Sampled/coalesced -- see the module comment above. `checkSeq` is the idempotency key a later
// synthetic-message projection enforces (TKT-322 diary 2435 §2), not built in this slice.
export const Checked = Event.define({
  type: "session.next.monitor.checked",
  ...options,
  schema: {
    ...Base,
    checkSeq: NonNegativeInt,
    triggered: Schema.Boolean,
  },
})
export type Checked = typeof Checked.Type

export const Triggered = Event.define({
  type: "session.next.monitor.triggered",
  ...options,
  schema: {
    ...Base,
    checkSeq: NonNegativeInt,
    result: Schema.String,
  },
})
export type Triggered = typeof Triggered.Type

export const Failed = Event.define({
  type: "session.next.monitor.failed",
  ...options,
  schema: {
    ...Base,
    reason: Schema.String,
  },
})
export type Failed = typeof Failed.Type

export const Cancelled = Event.define({
  type: "session.next.monitor.cancelled",
  ...options,
  schema: {
    ...Base,
  },
})
export type Cancelled = typeof Cancelled.Type

// Published by `recover` on startup for every monitor whose stored status was "starting" or
// "running" -- the row's PID, if any, is never read to decide this (design post; diary 2435 §1).
export const Orphaned = Event.define({
  type: "session.next.monitor.orphaned",
  ...options,
  schema: {
    ...Base,
    previousStatus: Monitor.Status,
  },
})
export type Orphaned = typeof Orphaned.Type

export const DurableDefinitions = Event.inventory(Created, Started, Checked, Triggered, Failed, Cancelled, Orphaned)
// Every Monitor event is durable -- there is no streaming/delta variant, unlike session-event.ts's
// Text/Reasoning/Tool.Input -- so the full definitions set is the same as the durable one.
export const Definitions = DurableDefinitions
