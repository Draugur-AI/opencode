import { describe, expect } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { DateTime, Effect, Exit } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionLifecycle } from "@opencode-ai/core/session/lifecycle"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionPurge } from "@opencode-ai/core/session/purge"
import {
  SessionContextEpochTable,
  SessionGoalTable,
  SessionInputTable,
  SessionLedgerTable,
  SessionMessageTable,
  SessionProfileSnapshotTable,
  SessionTable,
  SessionTombstoneTable,
  TodoTable,
} from "@opencode-ai/core/session/sql"
import { SessionLedger } from "@opencode-ai/core/session/ledger"
import { SessionProfile } from "@opencode-ai/core/session/profile"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const sessionsLayer = AppNodeBuilder.build(SessionV2.node, [[SessionExecution.node, SessionExecution.noopLayer]])

const request = (value: string) => SessionLifecycle.RequestID.make(value)

/**
 * Every table that holds session-owned rows, and what a purge must do with it.
 *
 * This list is the point of the inventory test. A new session-owned table added by a later slice
 * will not appear here, the discovery below will find it, and the test fails until someone states
 * its retention behaviour — which is how a future feature is stopped from silently keeping
 * transcript content after the user asked for permanent deletion.
 */
const SESSION_OWNED: Record<string, "purged" | "retained"> = {
  session: "purged",
  message: "purged",
  part: "purged",
  todo: "purged",
  session_message: "purged",
  session_input: "purged",
  session_context_epoch: "purged",
  session_lifecycle_request: "purged",
  // TKT-317: durable agent intent is exactly the content the design post's "Delete permanently"
  // row names ("Purge transcript, events, goals, ledger..."). Neither table holds anything worth
  // retaining once the session itself is gone.
  session_goal: "purged",
  session_ledger: "purged",
  // TKT-318: full-history search would be exactly the "search the transcript of a permanently
  // deleted session" leak the design post's "Delete permanently" row is meant to close. FTS5
  // virtual tables cannot declare a foreign key, so this one is deleted explicitly in purge.ts
  // rather than by ON DELETE CASCADE -- same reasoning as the event/event_sequence tables above.
  session_transcript_search: "purged",
  // Found by this test on the day it was written: a share row holds a live URL and secret for the
  // session. It already cascades, but nothing had ever stated that it must.
  session_share: "purged",
  // TKT-321: a resolved profile snapshot is behavior the session ran under, same class of content
  // as a goal or ledger entry -- nothing worth keeping once the session itself is gone.
  session_profile_snapshot: "purged",
  // The tombstone is what replaces the session. It carries identifiers only, never content.
  session_tombstone: "retained",
}

let seq = 0
const seedTrashed = (prefix: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const sessions = yield* SessionV2.Service
    const id = SessionV2.ID.make(`ses_${prefix}_${seq++}`)
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({ id, project_id: Project.ID.global, slug: id, directory: "/project", title: id, version: "test" })
      .run()
      .pipe(Effect.orDie)
    // Give the session a child row in each table a purge has to reach.
    yield* db
      .insert(SessionMessageTable)
      .values({ id: SessionMessage.ID.make(`msg_${id}`), session_id: id, type: "user", seq: 1, data: {} as never })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(TodoTable)
      .values({ session_id: id, content: "todo", status: "pending", priority: "high", position: 0 })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionContextEpochTable)
      .values({ session_id: id, baseline: "b", snapshot: {} as never, baseline_seq: 0 })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionInputTable)
      .values({
        id: SessionMessage.ID.make(`msg_in_${id}`),
        session_id: id,
        prompt: {} as never,
        delivery: "queue",
        admitted_seq: 1,
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionGoalTable)
      .values({
        session_id: id,
        objective: "goal",
        acceptance_criteria: [],
        constraints: [],
        source_message_ids: [],
        version: 1,
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionLedgerTable)
      .values({
        id: SessionLedger.ID.create(),
        session_id: id,
        kind: "fact",
        text: "ledger entry",
        source_message_ids: [],
        status: "active",
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .run(
        sql`INSERT INTO session_transcript_search (session_id, message_id, seq, role, text, created_at)
            VALUES (${id}, ${`msg_search_${id}`}, 0, 'user', 'searchable purge test text', 1)`,
      )
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionProfileSnapshotTable)
      .values({
        id: SessionProfile.SnapshotID.create(),
        session_id: id,
        definition_id: SessionProfile.ID.create(),
        definition_hash: "hash",
        title: "profile",
        tool_rules: {},
        skill_rules: {},
        mcp_rules: {},
        plugin_rules: {},
        hook_rules: {},
        monitor_rules: { allowUser: true, allowPlugin: true, autoStart: false },
        time_created: 1,
      })
      .run()
      .pipe(Effect.orDie)
    yield* sessions.trash({ sessionID: id, requestID: request(`trash-${id}`) })
    return id
  })

const countFor = (table: string, sessionID: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const columns = yield* db.all<{ name: string }>(sql.raw(`PRAGMA table_info(\`${table}\`)`)).pipe(Effect.orDie)
    const names = columns.map((column) => column.name)
    const key = names.includes("session_id") ? "session_id" : names.includes("id") ? "id" : undefined
    if (!key) return undefined
    const result = yield* db
      .get<{ total: number }>(sql.raw(`SELECT COUNT(*) AS total FROM \`${table}\` WHERE \`${key}\` = '${sessionID}'`))
      .pipe(Effect.orDie)
    return result?.total ?? 0
  })

describe("SessionPurge", () => {
  it.effect("removes every session-owned row and leaves exactly a tombstone", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessions = yield* SessionV2.Service
      const sessionID = yield* seedTrashed("purge_cascade")

      const tombstone = yield* sessions.purge({
        sessionID,
        requestID: request("p-cascade"),
        confirmation: sessionID,
      })

      expect(tombstone.id).toBe(sessionID)
      expect(tombstone.lastLifecycleRevision).toBeGreaterThan(0)

      for (const [table, expectation] of Object.entries(SESSION_OWNED)) {
        const total = yield* countFor(table, sessionID)
        if (expectation === "purged") expect({ table, total }).toEqual({ table, total: 0 })
        else expect({ table, total }).toEqual({ table, total: 1 })
      }

      // Durable events are keyed by aggregate rather than by a foreign key, so they do not cascade
      // and are deleted explicitly. A surviving event log would let a replay resurrect the session.
      const events = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(events.length).toBe(0)
      const sequence = yield* db
        .select()
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      expect(sequence).toBeUndefined()
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("fails when a session-owned table is not declared in the purge inventory", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      // Discover every table that could hold session-owned rows, rather than trusting the list.
      const tables = yield* db
        .all<{ name: string }>(
          sql.raw(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`),
        )
        .pipe(Effect.orDie)
      const owned: string[] = []
      for (const { name } of tables) {
        const columns = yield* db.all<{ name: string }>(sql.raw(`PRAGMA table_info(\`${name}\`)`)).pipe(Effect.orDie)
        if (columns.some((column) => column.name === "session_id")) owned.push(name)
      }
      const undeclared = owned.filter((name) => SESSION_OWNED[name] === undefined)
      // If this fails, a slice added a session-owned table without saying what a purge does with
      // it. Declare it in SESSION_OWNED — do not delete this assertion.
      expect(undeclared).toEqual([])
    }),
  )

  it.effect("refuses to purge a session that is not in trash", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessions = yield* SessionV2.Service
      const id = SessionV2.ID.make(`ses_purge_active_${seq++}`)
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({ id, project_id: Project.ID.global, slug: id, directory: "/project", title: id, version: "test" })
        .run()
        .pipe(Effect.orDie)

      const exit = yield* sessions.purge({ sessionID: id, requestID: request("p1"), confirmation: id }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, id)).get().pipe(Effect.orDie)
      expect(row).toBeDefined()
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("requires the session ID echoed back as confirmation", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const sessionID = yield* seedTrashed("purge_confirm")

      const exit = yield* sessions
        .purge({ sessionID, requestID: request("p2"), confirmation: SessionV2.ID.make("ses_wrong") })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      const row = yield* Effect.gen(function* () {
        const { db } = yield* Database.Service
        return yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
      })
      expect(row).toBeDefined()
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("is idempotent: a retried purge returns the same tombstone", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const sessionID = yield* seedTrashed("purge_retry")

      const first = yield* sessions.purge({ sessionID, requestID: request("p3"), confirmation: sessionID })
      const second = yield* sessions.purge({ sessionID, requestID: request("p3"), confirmation: sessionID })

      expect(second.id).toBe(first.id)
      expect(second.lastLifecycleRevision).toBe(first.lastLifecycleRevision)
      expect(DateTime.toEpochMillis(second.purgedAt)).toBe(DateTime.toEpochMillis(first.purgedAt))
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("reports a purged session by tombstone rather than as never having existed", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const sessionID = yield* seedTrashed("purge_tombstone")

      yield* sessions.purge({ sessionID, requestID: request("p4"), confirmation: sessionID })

      const found = yield* sessions.tombstone(sessionID)
      expect(found?.id).toBe(sessionID)
      // A client that cannot tell "deleted" from "not fetched yet" keeps a tab open on a session
      // that no longer exists, which is the failure the tombstone exists to prevent.
      const missing = yield* sessions.tombstone(SessionV2.ID.make("ses_never_existed"))
      expect(missing).toBeUndefined()
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("purges the whole subtree and writes a tombstone for EVERY session in it", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessions = yield* SessionV2.Service
      const parent = yield* seedTrashed("purge_parent")
      // Two children and a grandchild, so the walk has to go deeper than one level.
      const kids: SessionV2.ID[] = []
      for (const [suffix, parentOf] of [["child_a", parent], ["child_b", parent]] as const) {
        const id = SessionV2.ID.make(`ses_${suffix}_${seq++}`)
        yield* db
          .insert(SessionTable)
          .values({
            id,
            project_id: Project.ID.global,
            parent_id: parentOf,
            slug: id,
            directory: "/project",
            title: id,
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)
        kids.push(id)
      }
      const grandchild = SessionV2.ID.make(`ses_grandchild_${seq++}`)
      yield* db
        .insert(SessionTable)
        .values({
          id: grandchild,
          project_id: Project.ID.global,
          parent_id: kids[0],
          slug: grandchild,
          directory: "/project",
          title: grandchild,
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)

      yield* sessions.purge({ sessionID: parent, requestID: request("p-tree"), confirmation: parent })

      // Every row gone — a live orphan pointing at a tombstoned parent is worse than either
      // outcome on its own.
      for (const id of [parent, ...kids, grandchild]) {
        const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, id)).get().pipe(Effect.orDie)
        expect({ id, row }).toEqual({ id, row: undefined })
        // ...and each one has its OWN tombstone. A child ID is an ID some client still holds, so
        // a parent-only tombstone would leave every child indistinguishable from "not fetched".
        const stone = yield* sessions.tombstone(id)
        expect({ id, tombstoned: stone?.id }).toEqual({ id, tombstoned: id })
      }
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("a failed subtree purge leaves the WHOLE tree intact, not half of it", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessions = yield* SessionV2.Service
      const parent = yield* seedTrashed("purge_atomic")
      const child = SessionV2.ID.make(`ses_atomic_child_${seq++}`)
      yield* db
        .insert(SessionTable)
        .values({
          id: child,
          project_id: Project.ID.global,
          parent_id: parent,
          slug: child,
          directory: "/project",
          title: child,
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)

      // Wrong confirmation: refused before anything is deleted. The point of the assertion is the
      // CHILD — a purge that had already walked into the subtree before failing would leave it
      // missing while the parent survived, and nothing downstream would ever notice.
      yield* sessions
        .purge({ sessionID: parent, requestID: request("p-atomic"), confirmation: SessionV2.ID.make("ses_wrong") })
        .pipe(Effect.exit)

      for (const id of [parent, child]) {
        const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, id)).get().pipe(Effect.orDie)
        expect({ id, present: row !== undefined }).toEqual({ id, present: true })
        expect({ id, tombstoned: (yield* sessions.tombstone(id)) !== undefined }).toEqual({ id, tombstoned: false })
      }
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("the worker claims only sessions whose grace period has expired", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = yield* seedTrashed("purge_grace")

      // Read the deadline off the row rather than from the wall clock: the service stamps its
      // timestamps from the Effect clock, which under test starts at the epoch.
      const trashed = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
      const deadline = trashed!.purge_after!
      expect(deadline).toBe(trashed!.time_trashed! + SessionLifecycle.TrashGraceMillis)

      const early = yield* SessionPurge.eligible(db, { now: deadline - 1, limit: 10 })
      expect(early).not.toContain(sessionID)

      const after = yield* SessionPurge.eligible(db, { now: deadline, limit: 10 })
      expect(after).toContain(sessionID)
    }).pipe(Effect.provide(sessionsLayer)),
  )
})
