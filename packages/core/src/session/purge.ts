export * as SessionPurge from "./purge"

import { and, asc, eq, lte, sql, inArray} from "drizzle-orm"
import { DateTime, Effect } from "effect"
import type { Database } from "../database/database"
import { EventSequenceTable, EventTable } from "../event/sql"
import type { FSUtil } from "../fs-util"
import { SessionLifecycle } from "./lifecycle"
import { ProjectV2 } from "../project"
import { SessionSchema } from "./schema"
import { SessionTable, SessionTombstoneTable } from "./sql"

type DatabaseService = Database.Interface["db"]

export interface Claimed {
  /** The tombstone for the session that was asked for — the root of the purged subtree. */
  readonly tombstone: SessionLifecycle.Tombstone
  /**
   * Every tombstone written, root first then descendants. A child session ID is an ID some
   * client may still hold — an open tab, a recently-closed entry — so each purged child needs
   * its OWN tombstone. A parent-only tombstone would leave every child indistinguishable from
   * "not fetched yet", which is the exact confusion tombstones exist to remove, rebuilt one
   * level down.
   */
  readonly tombstones: ReadonlyArray<SessionLifecycle.Tombstone>
  /** Managed tool-output files owned by the purged subtree. Removed only after the commit. */
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

        // The whole subtree, deepest first. `parent_id` is a plain column with no foreign key, so
        // children do NOT cascade with their parent — purging only the root would leave live
        // orphans pointing at a tombstoned parent, which is worse than either outcome alone.
        const subtree = yield* descendants(db, input.sessionID)

        const objects: string[] = []
        const tombstones: SessionLifecycle.Tombstone[] = []

        for (const target of subtree) {
          objects.push(...(yield* managedObjects(db, target.id)))

          // Durable events are keyed by aggregate, not by a foreign key, so they do not cascade.
          // Inlined rather than calling EventV2.remove so the whole purge is one transaction: a
          // crash between two transactions would leave events for a session that no longer exists.
          yield* db.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, target.id)).run()
          yield* db.delete(EventTable).where(eq(EventTable.aggregate_id, target.id)).run()
          // FTS5 virtual tables cannot declare a foreign key, so session_transcript_search cannot
          // cascade like the ordinary relational child tables below -- same reasoning as the
          // aggregate-keyed event tables just above, deleted explicitly for the same reason.
          yield* db.run(sql`DELETE FROM session_transcript_search WHERE session_id = ${target.id}`)
          // Every child table declares `onDelete: "cascade"`, and `PRAGMA foreign_keys = ON` is set
          // when the database opens. The purge inventory test is what keeps that true for tables
          // added later.
          yield* db.delete(SessionTable).where(eq(SessionTable.id, target.id)).run()

          yield* db
            .insert(SessionTombstoneTable)
            .values({
              id: target.id,
              project_id: target.projectID,
              time_purged: input.now,
              last_lifecycle_revision: target.lifecycleRevision,
            })
            .onConflictDoNothing()
            .run()

          tombstones.push(
            SessionLifecycle.Tombstone.make({
              id: target.id,
              projectID: target.projectID,
              purgedAt: DateTime.makeUnsafe(input.now),
              lastLifecycleRevision: target.lifecycleRevision,
            }),
          )
        }

        const root = tombstones.find((t) => t.id === input.sessionID)
        if (!root) return undefined
        return { tombstone: root, tombstones, objects } satisfies Claimed
      }),
    )
    .pipe(Effect.orDie)
})

/**
 * The session and everything beneath it, DEEPEST FIRST.
 *
 * Ordering matters for the reader, not for the database: the whole purge is one transaction, so a
 * crash at any point rolls the entire subtree back rather than leaving half a tree deleted. That
 * is the recovery answer — there is no partial state to recover FROM. Deepest-first simply keeps
 * the delete order matching the containment order, so anyone stepping through it sees children go
 * before the parent they belong to.
 */
const descendants = Effect.fn("SessionPurge.descendants")(function* (
  db: DatabaseService,
  rootID: SessionSchema.ID,
) {
  type Node = { id: SessionSchema.ID; projectID: ProjectV2.ID; lifecycleRevision: number }
  const ordered: Node[] = []
  let frontier: SessionSchema.ID[] = [rootID]
  // Breadth-first down, then reversed: a session tree is shallow (GitHub-style sub-issue depth,
  // not a filesystem), so this is a handful of queries rather than a recursive CTE.
  while (frontier.length > 0) {
    const rows = yield* db
      .select({
        id: SessionTable.id,
        projectID: SessionTable.project_id,
        lifecycleRevision: SessionTable.lifecycle_revision,
      })
      .from(SessionTable)
      .where(inArray(SessionTable.id, frontier))
      .all()
      .pipe(Effect.orDie)
    for (const r of rows) {
      ordered.push({
        id: SessionSchema.ID.make(r.id),
        projectID: r.projectID,
        lifecycleRevision: r.lifecycleRevision,
      })
    }
    const children = yield* db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(inArray(SessionTable.parent_id, frontier))
      .all()
      .pipe(Effect.orDie)
    frontier = children.map((c) => SessionSchema.ID.make(c.id))
  }
  return ordered.reverse()
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
