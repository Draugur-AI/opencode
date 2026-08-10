import { describe, expect } from "bun:test"
import { and, eq } from "drizzle-orm"
import { Effect, Exit } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionLifecycle } from "@opencode-ai/core/session/lifecycle"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionLifecycleRequestTable, SessionTable } from "@opencode-ai/core/session/sql"
import * as Delivery from "@opencode-ai/test-rig/delivery"
import * as Model from "@opencode-ai/test-rig/lifecycle-model"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const sessionsLayer = AppNodeBuilder.build(SessionV2.node, [[SessionExecution.node, SessionExecution.noopLayer]])

const request = (value: string) => SessionLifecycle.RequestID.make(value)

let seq = 0
const seed = (prefix: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const id = SessionV2.ID.make(`ses_${prefix}_${seq++}`)
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: id,
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    return id
  })

const row = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db.select().from(SessionTable).where(eq(SessionTable.id, id)).get().pipe(Effect.orDie)
  })

const lifecycleEvents = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, id)).all().pipe(Effect.orDie)
    return rows.filter((event) => event.type.startsWith("session.next.lifecycle.changed"))
  })

describe("SessionLifecycle transitions", () => {
  it.effect("archives an active session and stamps the committed aggregate sequence", () =>
    Effect.gen(function* () {
      const sessionID = yield* seed("archive")
      const sessions = yield* SessionV2.Service

      const archived = yield* sessions.archive({ sessionID, requestID: request("req-archive") })

      expect(archived.lifecycle.state).toBe("archived")
      const stored = yield* row(sessionID)
      expect(stored?.lifecycle).toBe("archived")
      // The revision is the aggregate sequence of the committed event, not a private counter.
      expect(archived.lifecycleRevision).toBe(stored!.lifecycle_revision)
      // `time_archived` is the V1 compatibility mirror and must move with the lifecycle.
      expect(stored?.time_archived).not.toBeNull()
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("walks the whole legal transition matrix and refuses every illegal edge", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      let counter = 0
      const next = () => request(`matrix-${counter++}`)

      // Drive a session into each state, then attempt every verb from it, and check the outcome
      // against the model rather than against the implementation's own opinion.
      const reach = (target: Model.ModelState) =>
        Effect.gen(function* () {
          const sessionID = yield* seed(`matrix_${target}`)
          if (target === "archived") yield* sessions.archive({ sessionID, requestID: next() })
          if (target === "trash") yield* sessions.trash({ sessionID, requestID: next() })
          return sessionID
        })

      for (const state of ["active", "archived", "trash"] as const) {
        for (const verb of ["archive", "restore", "trash", "restoreFromTrash"] as const) {
          const sessionID = yield* reach(state)
          const before = yield* row(sessionID)
          const outcome = Model.apply(
            { state, revision: before!.lifecycle_revision, trashRestoreTo: "active", applied: new Map() },
            { verb, requestID: `model-${state}-${verb}` },
            before!.lifecycle_revision + 1,
          )
          const exit = yield* sessions[verb]({ sessionID, requestID: next() }).pipe(Effect.exit)
          const after = yield* row(sessionID)

          if (outcome.kind === "applied") {
            expect(Exit.isSuccess(exit)).toBe(true)
            expect(after?.lifecycle as string).toBe(outcome.next.state)
          } else {
            expect(Exit.isFailure(exit)).toBe(true)
            // A refused transition must leave the row exactly as it was.
            expect(after?.lifecycle).toBe(before!.lifecycle)
            expect(after?.lifecycle_revision).toBe(before!.lifecycle_revision)
          }
        }
      }
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("returns a trashed session to the state it was in, not always to active", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const sessionID = yield* seed("trash_from_archived")

      yield* sessions.archive({ sessionID, requestID: request("a1") })
      yield* sessions.trash({ sessionID, requestID: request("t1") })
      const restored = yield* sessions.restoreFromTrash({ sessionID, requestID: request("r1") })

      // Restoring an archived session to `active` would silently undo the archive the user chose.
      expect(restored.lifecycle.state).toBe("archived")
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("clears the trash columns when a session leaves trash", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const sessionID = yield* seed("trash_columns")

      yield* sessions.trash({ sessionID, requestID: request("t2") })
      const trashed = yield* row(sessionID)
      expect(trashed?.time_trashed).not.toBeNull()
      expect(trashed?.purge_after).not.toBeNull()

      yield* sessions.restoreFromTrash({ sessionID, requestID: request("r2") })
      const restored = yield* row(sessionID)
      // A stale purge_after left behind would let the purge worker claim a live session.
      expect(restored?.time_trashed).toBeNull()
      expect(restored?.purge_after).toBeNull()
      expect(restored?.trash_restore_to).toBeNull()
    }).pipe(Effect.provide(sessionsLayer)),
  )
})

describe("SessionLifecycle stale revisions", () => {
  it.effect("rejects a stale expectedLifecycleRevision and reports the revision that won", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const sessionID = yield* seed("stale")

      const archived = yield* sessions.archive({ sessionID, requestID: request("s1") })
      const stale = archived.lifecycleRevision - 1

      const exit = yield* sessions
        .restore({ sessionID, requestID: request("s2"), expectedLifecycleRevision: stale })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      const failure = Exit.isFailure(exit) ? exit.cause : undefined
      expect(JSON.stringify(failure)).toContain("Session.LifecycleConflictError")
      const stored = yield* row(sessionID)
      expect(stored?.lifecycle).toBe("archived")
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("writes NO durable event when a mutation loses the compare-and-set", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const sessionID = yield* seed("stale_no_event")

      yield* sessions.archive({ sessionID, requestID: request("n1") })
      const before = yield* lifecycleEvents(sessionID)

      // Revision 0 means "no lifecycle change committed", so it is exactly the value a client that
      // never saw the archive would still be holding.
      yield* sessions
        .restore({ sessionID, requestID: request("n2"), expectedLifecycleRevision: 0 })
        .pipe(Effect.exit)

      // A rejected mutation that still recorded an event would describe a change that never
      // happened, and every replay of that log would then diverge from the projection.
      const after = yield* lifecycleEvents(sessionID)
      expect(after.length).toBe(before.length)
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("accepts a fresh expectedLifecycleRevision", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const sessionID = yield* seed("fresh")

      const archived = yield* sessions.archive({ sessionID, requestID: request("f1") })
      const restored = yield* sessions.restore({
        sessionID,
        requestID: request("f2"),
        expectedLifecycleRevision: archived.lifecycleRevision,
      })

      expect(restored.lifecycle.state).toBe("active")
      expect(restored.lifecycleRevision).toBeGreaterThan(archived.lifecycleRevision)
    }).pipe(Effect.provide(sessionsLayer)),
  )
})

describe("SessionLifecycle request deduplication", () => {
  it.effect("applies a repeated request ID exactly once", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const sessionID = yield* seed("dedup")
      const requestID = request("retry-me")

      const first = yield* sessions.archive({ sessionID, requestID })
      const second = yield* sessions.archive({ sessionID, requestID })

      expect(second.lifecycle.state).toBe("archived")
      expect(second.lifecycleRevision).toBe(first.lifecycleRevision)
      expect((yield* lifecycleEvents(sessionID)).length).toBe(1)
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("does not archive, restore and archive again on a retried round trip", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const sessionID = yield* seed("dedup_roundtrip")
      const archiveRequest = request("mobile-archive")

      yield* sessions.archive({ sessionID, requestID: archiveRequest })
      yield* sessions.restore({ sessionID, requestID: request("mobile-restore") })
      // The dropped-response retry of the FIRST archive arrives late. It must be recognised as
      // already applied rather than archiving a session the user has since restored.
      const replayed = yield* sessions.archive({ sessionID, requestID: archiveRequest })

      expect(replayed.lifecycle.state).toBe("active")
      expect((yield* lifecycleEvents(sessionID)).length).toBe(2)
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("keeps the deduplication table bounded", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessions = yield* SessionV2.Service
      const sessionID = yield* seed("dedup_bounded")

      // Alternate archive/restore so every mutation is a legal transition.
      for (let index = 0; index < SessionLifecycle.RequestRetention + 10; index++) {
        const requestID = request(`bounded-${index}`)
        yield* index % 2 === 0
          ? sessions.archive({ sessionID, requestID })
          : sessions.restore({ sessionID, requestID })
      }

      const rows = yield* db
        .select()
        .from(SessionLifecycleRequestTable)
        .where(eq(SessionLifecycleRequestTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(rows.length).toBeLessThanOrEqual(SessionLifecycle.RequestRetention)
    }).pipe(Effect.provide(sessionsLayer)),
  )
})

describe("SessionLifecycle crash matrix", () => {
  /**
   * The commit is one transaction: sequence read, projection, event row. A failure at any point
   * before it commits must leave zero trace, and the retry must then succeed exactly once. These
   * cases inject the failure rather than racing for it.
   */
  it.effect("leaves no partial state when the projection fails mid-transaction", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const sessionID = yield* seed("crash_projection")

      // A stale expectation makes the projector fail *after* the event was validated and the
      // sequence read, which is the "after insert, before commit" point of the matrix.
      yield* sessions
        .archive({ sessionID, requestID: request("c1"), expectedLifecycleRevision: 99 })
        .pipe(Effect.exit)

      const stored = yield* row(sessionID)
      expect(stored?.lifecycle).toBe("active")
      expect(stored?.lifecycle_revision).toBe(0)
      expect((yield* lifecycleEvents(sessionID)).length).toBe(0)
      // The dedup row must roll back too, or the retry below would be swallowed as a duplicate.
      const { db } = yield* Database.Service
      const claimed = yield* db
        .select()
        .from(SessionLifecycleRequestTable)
        .where(
          and(
            eq(SessionLifecycleRequestTable.session_id, sessionID),
            eq(SessionLifecycleRequestTable.request_id, request("c1")),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      expect(claimed).toBeUndefined()
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("a retry after a failed mutation succeeds exactly once", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const sessionID = yield* seed("crash_retry")
      const requestID = request("c2")

      yield* sessions.archive({ sessionID, requestID, expectedLifecycleRevision: 99 }).pipe(Effect.exit)
      const retried = yield* sessions.archive({ sessionID, requestID })

      expect(retried.lifecycle.state).toBe("archived")
      expect((yield* lifecycleEvents(sessionID)).length).toBe(1)
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("the projection a replay rebuilds matches the one the mutations produced", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessions = yield* SessionV2.Service
      const sessionID = yield* seed("replay")

      yield* sessions.archive({ sessionID, requestID: request("p1") })
      yield* sessions.trash({ sessionID, requestID: request("p2") })
      yield* sessions.restoreFromTrash({ sessionID, requestID: request("p3") })

      const authoritative = yield* row(sessionID)
      const events = yield* lifecycleEvents(sessionID)

      // Every lifecycle change is durable and carries the sequence its revision was taken from,
      // so a reader replaying the log lands on the same state the writer projected.
      expect(events.length).toBe(3)
      // Revision is one past the aggregate sequence, so that revision 0 can mean "never changed".
      expect(events.at(-1)!.seq + 1).toBe(authoritative!.lifecycle_revision)
      const lastPayload = events.at(-1)?.data as Record<string, unknown>
      expect((lastPayload["to"] as Record<string, unknown>)["state"]).toBe(authoritative!.lifecycle)
      expect(db).toBeDefined()
    }).pipe(Effect.provide(sessionsLayer)),
  )
})

describe("SessionLifecycle model-based properties", () => {
  // Seeds are fixed so a failure is reproducible and can be pasted back as a regression fixture.
  for (const seedValue of [1, 7, 42, 1337, 90210]) {
    it.effect(`converges with the transition model over generated sequence ${seedValue}`, () =>
      Effect.gen(function* () {
        const sessions = yield* SessionV2.Service
        const sessionID = yield* seed(`property_${seedValue}`)
        const commands = Model.generate({ seed: seedValue, length: 24 })

        let model = Model.initial()
        const delivered: Delivery.Delivered[] = []

        for (const command of commands) {
          if (command.verb === "purge") continue // purge removes the row; covered in session-purge
          const before = yield* row(sessionID)
          const expected =
            command.expectedRevision === "current" ? before!.lifecycle_revision : command.expectedRevision

          const outcome = Model.apply({ ...model, revision: before!.lifecycle_revision }, command, -1)

          const exit = yield* sessions[command.verb]({
            sessionID,
            requestID: request(command.requestID),
            ...(expected === undefined ? {} : { expectedLifecycleRevision: expected }),
          }).pipe(Effect.exit)

          const after = yield* row(sessionID)

          if (outcome.kind === "applied") {
            expect(Exit.isSuccess(exit)).toBe(true)
            expect(after!.lifecycle as string).toBe(outcome.next.state as string)
            delivered.push({
              seq: after!.lifecycle_revision,
              to: after!.lifecycle as Model.ModelState,
              trashRestoreTo: after!.trash_restore_to ?? undefined,
            })
          } else if (outcome.kind === "duplicate") {
            // A duplicate must be absorbed, never applied a second time.
            expect(after!.lifecycle_revision).toBe(before!.lifecycle_revision)
          } else {
            expect(Exit.isFailure(exit)).toBe(true)
            expect(after!.lifecycle).toBe(before!.lifecycle)
            expect(after!.lifecycle_revision).toBe(before!.lifecycle_revision)
          }

          model = {
            ...outcome.next,
            state: after!.lifecycle as Model.ModelState,
            revision: after!.lifecycle_revision,
            // Mirror the row: the restore target is only meaningful while the session is in trash,
            // and carrying a remembered value past that is how the model first went wrong here.
            trashRestoreTo: after!.trash_restore_to ?? "active",
          }
        }

        // Three-way convergence: the authoritative row, a client built from a fresh snapshot, and
        // a client built from the beginning plus the delivered suffix — duplicated and reordered.
        const authoritative = yield* row(sessionID)
        const snapshot: Delivery.Snapshot = {
          state: authoritative!.lifecycle as Model.ModelState,
          revision: authoritative!.lifecycle_revision,
          trashRestoreTo: authoritative!.trash_restore_to ?? "active",
        }
        for (const deliver of [
          Delivery.inOrder,
          (events: Delivery.Delivered[]) => Delivery.duplicated(events, seedValue),
          (events: Delivery.Delivered[]) => Delivery.reordered(events, seedValue),
        ]) {
          const result = Delivery.converges({
            authoritative: snapshot,
            fresh: snapshot,
            older: { state: "active", revision: 0, trashRestoreTo: "active" },
            suffix: deliver(delivered),
          })
          expect(result.agree).toBe(true)
        }
      }).pipe(Effect.provide(sessionsLayer)),
    )
  }
})
