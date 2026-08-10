export * as SessionLifecycle from "./lifecycle"

import { and, desc, eq, notInArray } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { SessionLifecycle as LifecycleSchema } from "@opencode-ai/schema/session-lifecycle"
import { NonNegativeInt } from "@opencode-ai/schema/schema"
import type { Database } from "../database/database"
import { SessionSchema } from "./schema"
import { SessionLifecycleRequestTable, SessionTable } from "./sql"

type DatabaseService = Database.Interface["db"]

export const Value = LifecycleSchema.Value
export type Value = LifecycleSchema.Value
export const State = LifecycleSchema.State
export type State = LifecycleSchema.State
export const Filter = LifecycleSchema.Filter
export type Filter = LifecycleSchema.Filter
export const RequestID = LifecycleSchema.RequestID
export type RequestID = LifecycleSchema.RequestID
export const Tombstone = LifecycleSchema.Tombstone
export type Tombstone = LifecycleSchema.Tombstone

/** How long a trashed session stays recoverable before the purge worker is allowed to claim it. */
export const TrashGraceMillis = 30 * 24 * 60 * 60 * 1000

/** How many lifecycle request records to keep per session. Retries are near-term; history is not. */
export const RequestRetention = 64

/** A state a session can be restored to out of trash. Trash cannot restore into trash. */
export type RestorableState = Exclude<State, "trash">

/**
 * The legal transitions, as one table rather than as conditionals spread across the verbs.
 * `purged` is absent on purpose: purging removes the row, so it is not a state this maps into.
 */
const TRANSITIONS: Record<State, ReadonlySet<State>> = {
  active: new Set<State>(["archived", "trash"]),
  archived: new Set<State>(["active", "trash"]),
  trash: new Set<State>(["active", "archived"]),
}

export const canTransition = (from: State, to: State) => TRANSITIONS[from].has(to)

/**
 * Raised when the row no longer looks the way the caller believed it did — a stale
 * `expectedLifecycleRevision`, or a `from` state some other writer already moved past. Thrown as a
 * defect from inside the commit transaction so the whole event is rolled back rather than
 * committed against a row it does not describe; the service converts it to a typed error.
 */
export class Conflict extends Schema.TaggedErrorClass<Conflict>()("SessionLifecycle.Conflict", {
  sessionID: SessionSchema.ID,
  expectedLifecycleRevision: NonNegativeInt.pipe(Schema.optional),
}) {}

/** Raised when a second delivery of the same request ID reaches the transaction. */
export class DuplicateRequest extends Schema.TaggedErrorClass<DuplicateRequest>()("SessionLifecycle.DuplicateRequest", {
  sessionID: SessionSchema.ID,
  requestID: LifecycleSchema.RequestID,
}) {}

export const fromRow = (row: {
  readonly lifecycle: State
  readonly time_archived: number | null
  readonly time_updated: number
  readonly time_trashed: number | null
  readonly purge_after: number | null
}): Value => {
  switch (row.lifecycle) {
    case "active":
      return { state: "active" }
    case "archived":
      return { state: "archived", at: DateTime.makeUnsafe(row.time_archived ?? row.time_updated) }
    case "trash":
      return {
        state: "trash",
        at: DateTime.makeUnsafe(row.time_trashed ?? row.time_updated),
        purgeAfter: DateTime.makeUnsafe(row.purge_after ?? (row.time_trashed ?? row.time_updated) + TrashGraceMillis),
      }
  }
}

/** The row shape a lifecycle value projects to. Every lifecycle column is written on every change,
 * so no stale timestamp can survive a transition it does not belong to. */
const toRow = (value: Value, from: State) => ({
  lifecycle: value.state,
  // `time_archived` mirrors "is archived" exactly. It is the V1 compatibility column and is
  // cleared by every transition out of `archived`.
  time_archived: value.state === "archived" ? DateTime.toEpochMillis(value.at) : null,
  time_trashed: value.state === "trash" ? DateTime.toEpochMillis(value.at) : null,
  purge_after: value.state === "trash" ? DateTime.toEpochMillis(value.purgeAfter) : null,
  trash_restore_to: value.state === "trash" ? (from as RestorableState) : null,
})

/**
 * Apply one committed `LifecycleChanged` event. Runs inside the durable event transaction, so its
 * compare-and-set is the authoritative one: losing it rolls the event back rather than recording an
 * event that describes a row that never changed.
 */
export const project = Effect.fn("SessionLifecycle.project")(function* (
  db: DatabaseService,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly from: Value
    readonly to: Value
    readonly requestID: RequestID
    readonly expectedLifecycleRevision?: number
    /** The aggregate sequence this event committed at. */
    readonly aggregateSeq: number
    readonly timestamp: DateTime.Utc
  },
) {
  // One past the aggregate sequence, because aggregate sequences start at 0 and so does the
  // column default. Using the sequence directly would make revision 0 mean both "never changed"
  // and "changed once", and a client holding the pre-change value would then pass its own
  // compare-and-set and undo a change it never saw. Revision 0 now means exactly "no lifecycle
  // change has been committed".
  const revision = input.aggregateSeq + 1
  const claimed = yield* db
    .insert(SessionLifecycleRequestTable)
    .values({
      session_id: input.sessionID,
      request_id: input.requestID,
      lifecycle_revision: revision,
      time_created: DateTime.toEpochMillis(input.timestamp),
    })
    .onConflictDoNothing()
    .returning({ requestID: SessionLifecycleRequestTable.request_id })
    .get()
    .pipe(Effect.orDie)
  if (!claimed)
    return yield* Effect.die(new DuplicateRequest({ sessionID: input.sessionID, requestID: input.requestID }))

  const updated = yield* db
    .update(SessionTable)
    .set({
      ...toRow(input.to, input.from.state),
      lifecycle_revision: revision,
      time_updated: DateTime.toEpochMillis(input.timestamp),
    })
    .where(
      and(
        eq(SessionTable.id, input.sessionID),
        eq(SessionTable.lifecycle, input.from.state),
        ...(input.expectedLifecycleRevision === undefined
          ? []
          : [eq(SessionTable.lifecycle_revision, input.expectedLifecycleRevision)]),
      ),
    )
    .returning({ id: SessionTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!updated)
    return yield* Effect.die(
      new Conflict({ sessionID: input.sessionID, expectedLifecycleRevision: input.expectedLifecycleRevision }),
    )

  yield* prune(db, input.sessionID)
})

/** Keep the dedup table bounded: retries are near-term, so only the newest records are useful. */
const prune = Effect.fn("SessionLifecycle.prune")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const keep = db
    .select({ request_id: SessionLifecycleRequestTable.request_id })
    .from(SessionLifecycleRequestTable)
    .where(eq(SessionLifecycleRequestTable.session_id, sessionID))
    .orderBy(desc(SessionLifecycleRequestTable.time_created))
    .limit(RequestRetention)
  yield* db
    .delete(SessionLifecycleRequestTable)
    .where(
      and(
        eq(SessionLifecycleRequestTable.session_id, sessionID),
        notInArray(SessionLifecycleRequestTable.request_id, keep),
      ),
    )
    .run()
    .pipe(Effect.orDie)
})

/** The revision a previously applied request produced, or undefined if this request is new. */
export const findRequest = Effect.fn("SessionLifecycle.findRequest")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  requestID: RequestID,
) {
  const row = yield* db
    .select({ revision: SessionLifecycleRequestTable.lifecycle_revision })
    .from(SessionLifecycleRequestTable)
    .where(
      and(
        eq(SessionLifecycleRequestTable.session_id, sessionID),
        eq(SessionLifecycleRequestTable.request_id, requestID),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  return row?.revision
})
