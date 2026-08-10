export * as SessionPurge from "./purge"

import { and, asc, eq, lte } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import type { Database } from "../database/database"
import { EventSequenceTable, EventTable } from "../event/sql"
import type { FSUtil } from "../fs-util"
import { SessionLifecycle } from "./lifecycle"
import { SessionSchema } from "./schema"
import { SessionTable, SessionTombstoneTable } from "./sql"

type DatabaseService = Database.Interface["db"]

export interface Claimed {
  readonly tombstone: SessionLifecycle.Tombstone
  /** Managed tool-output files owned by the purged session. Removed only after the commit. */
  readonly objects: ReadonlyArray<string>
}

/** Trashed sessions whose grace period has expired, oldest first. */
export const eligible = Effect.fn("SessionPurge.eligible")(function* (
  db: DatabaseService,
  input: { readonly now: number; readonly limit: number },
) {
  const rows = yield* db
    .select({ id: SessionTable.id })
    .from(SessionTable)
    .where(and(eq(SessionTable.lifecycle, "trash"), lte(SessionTable.purge_after, input.now)))
    .orderBy(asc(SessionTable.purge_after))
    .limit(input.limit)
    .all()
    .pipe(Effect.orDie)
  return rows.map((row) => SessionSchema.ID.make(row.id))
})

/**
 * Delete one trashed session and everything it owns, in one transaction, and record the tombstone
 * that replaces it. Returns the managed objects the caller must remove after the commit —
 * unlinking a file before the transaction commits would lose data if the transaction rolls back.
 *
 * `requireExpired` distinguishes the two callers: the background worker may only take sessions
 * whose grace period has run out, while an explicit permanent-delete takes the session now.
 * Both run this same operation, so there is no second deletion path to keep in step.
 */
export const claim = Effect.fn("SessionPurge.claim")(function* (
  db: DatabaseService,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly now: number
    readonly requireExpired: boolean
  },
) {
  return yield* db
    .transaction(() =>
      Effect.gen(function* () {
        const row = yield* db
          .select({
            id: SessionTable.id,
            projectID: SessionTable.project_id,
            lifecycleRevision: SessionTable.lifecycle_revision,
          })
          .from(SessionTable)
          .where(
            and(
              eq(SessionTable.id, input.sessionID),
              eq(SessionTable.lifecycle, "trash"),
              ...(input.requireExpired ? [lte(SessionTable.purge_after, input.now)] : []),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (!row) return undefined

        const objects = yield* managedObjects(db, input.sessionID)

        // Durable events are keyed by aggregate, not by a foreign key, so they do not cascade.
        // Inlined rather than calling EventV2.remove so the whole purge is one transaction: a
        // crash between two transactions would leave events for a session that no longer exists.
        yield* db.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, input.sessionID)).run()
        yield* db.delete(EventTable).where(eq(EventTable.aggregate_id, input.sessionID)).run()
        // Every child table declares `onDelete: "cascade"`, and `PRAGMA foreign_keys = ON` is set
        // when the database opens. The purge inventory test is what keeps that true for tables
        // added later.
        yield* db.delete(SessionTable).where(eq(SessionTable.id, input.sessionID)).run()

        yield* db
          .insert(SessionTombstoneTable)
          .values({
            id: input.sessionID,
            project_id: row.projectID,
            time_purged: input.now,
            last_lifecycle_revision: row.lifecycleRevision,
          })
          .onConflictDoNothing()
          .run()

        return {
          tombstone: SessionLifecycle.Tombstone.make({
            id: input.sessionID,
            projectID: row.projectID,
            purgedAt: DateTime.makeUnsafe(input.now),
            lastLifecycleRevision: row.lifecycleRevision,
          }),
          objects,
        } satisfies Claimed
      }),
    )
    .pipe(Effect.orDie)
})

/**
 * Managed tool-output files this session produced, read from its durable events rather than its
 * projected messages: a reverted message is removed from the projection while the file it wrote
 * stays on disk, and a purge that consulted only the projection would leak it.
 */
const managedObjects = Effect.fn("SessionPurge.managedObjects")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const rows = yield* db
    .select({ data: EventTable.data })
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, sessionID))
    .all()
    .pipe(Effect.orDie)
  const paths = new Set<string>()
  for (const row of rows) {
    const value = (row.data as Record<string, unknown> | null)?.["outputPaths"]
    if (!Array.isArray(value)) continue
    for (const entry of value) if (typeof entry === "string") paths.add(entry)
  }
  return Array.from(paths)
})

/** Remove managed objects after the purge transaction committed. A file already gone is fine. */
export const removeObjects = Effect.fn("SessionPurge.removeObjects")(function* (
  fs: FSUtil.Interface,
  objects: ReadonlyArray<string>,
) {
  for (const file of objects) {
    yield* fs.remove(file).pipe(Effect.catch(() => Effect.void))
  }
})

/** The tombstone left behind by a purged session, if it is still within its retention window. */
export const tombstone = Effect.fn("SessionPurge.tombstone")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select()
    .from(SessionTombstoneTable)
    .where(eq(SessionTombstoneTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)
  return row === undefined
    ? undefined
    : SessionLifecycle.Tombstone.make({
        id: SessionSchema.ID.make(row.id),
        projectID: row.project_id,
        purgedAt: DateTime.makeUnsafe(row.time_purged),
        lastLifecycleRevision: row.last_lifecycle_revision,
      })
})
