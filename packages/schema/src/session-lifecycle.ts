export * as SessionLifecycle from "./session-lifecycle"

import { Schema } from "effect"
import { DateTimeUtcFromMillis, NonNegativeInt } from "./schema"
import { Project } from "./project"
import { SessionID } from "./session-id"

/**
 * Caller-supplied idempotency key for one lifecycle mutation. A retry after a dropped response
 * repeats the key, and the second attempt is recognised rather than applied again.
 */
export const RequestID = Schema.Trim.pipe(Schema.check(Schema.isNonEmpty()), Schema.brand("Session.Lifecycle.RequestID"))
export type RequestID = typeof RequestID.Type

export const Active = Schema.Struct({
  state: Schema.Literal("active"),
}).annotate({ identifier: "Session.Lifecycle.Active" })

export const Archived = Schema.Struct({
  state: Schema.Literal("archived"),
  at: DateTimeUtcFromMillis,
}).annotate({ identifier: "Session.Lifecycle.Archived" })

export const Trash = Schema.Struct({
  state: Schema.Literal("trash"),
  at: DateTimeUtcFromMillis,
  purgeAfter: DateTimeUtcFromMillis,
}).annotate({ identifier: "Session.Lifecycle.Trash" })

export const Value = Schema.Union([Active, Archived, Trash])
  .pipe(Schema.toTaggedUnion("state"))
  .annotate({ identifier: "Session.Lifecycle" })
export type Value = typeof Value.Type

/** The durable states a session row can hold. `purged` is deliberately absent: a purged session has no row. */
export const State = Schema.Literals(["active", "archived", "trash"]).annotate({
  identifier: "Session.Lifecycle.State",
})
export type State = typeof State.Type

/** Lifecycle views a list request can ask for. */
export const Filter = Schema.Literals(["active", "archived", "trash", "all"]).annotate({
  identifier: "Session.Lifecycle.Filter",
})
export type Filter = typeof Filter.Type

/**
 * What remains of a purged session. Returned for a bounded retention period so a client can
 * distinguish "deleted" from "not fetched yet"; after that period the ID is a plain 404.
 * It carries no transcript content.
 */
export const Tombstone = Schema.Struct({
  id: SessionID,
  projectID: Project.ID,
  purgedAt: DateTimeUtcFromMillis,
  lastLifecycleRevision: NonNegativeInt,
}).annotate({ identifier: "Session.Tombstone" })
export interface Tombstone extends Schema.Schema.Type<typeof Tombstone> {}
