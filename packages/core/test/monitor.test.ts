import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { Monitor } from "@opencode-ai/core/monitor"
import { MonitorTable } from "@opencode-ai/core/monitor/sql"
import { MonitorEvent } from "@opencode-ai/schema/monitor-event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { DateTime, Effect } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node, Monitor.node])),
)

let seq = 0
const seed = () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const id = SessionV2.ID.make(`ses_monitor_${seq++}`)
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
    return id
  })

const declare = (sessionID: SessionV2.ID, title = "watch build") =>
  Effect.gen(function* () {
    const monitor = yield* Monitor.Service
    return yield* monitor.create({
      sessionID,
      title,
      source: { type: "command", command: "echo hi" },
      intervalMs: 1000,
      timeoutMs: 5000,
      condition: { type: "exit-code", expect: 0 },
      outputPolicy: {},
    })
  })

describe("Monitor", () => {
  it.effect("create declares a monitor row, starting status, immediately readable", () =>
    Effect.gen(function* () {
      const monitor = yield* Monitor.Service
      const sessionID = yield* seed()

      const created = yield* declare(sessionID)
      expect(created.status).toBe("starting")
      expect(created.attempt).toBe(0)
      expect(created.revision).toBeGreaterThan(0)

      const read = yield* monitor.get(created.id)
      expect(read?.title).toBe("watch build")
      expect(read?.sessionID).toBe(sessionID)
    }),
  )

  it.effect("a declaration committed durably is readable without anything else running afterward -- the crash point between event commit and any later step cannot lose it", () =>
    Effect.gen(function* () {
      const monitor = yield* Monitor.Service
      const sessionID = yield* seed()

      const created = yield* declare(sessionID, "post-crash check")

      // Simulate "the process died right after the event committed": a fresh get() (no runtime,
      // no recovery, nothing else) must still see the fully-committed row.
      const recovered = yield* monitor.get(created.id)
      expect(recovered?.title).toBe("post-crash check")
      expect(recovered?.status).toBe("starting")
    }),
  )

  it.effect("list returns only the monitors declared under that session", () =>
    Effect.gen(function* () {
      const monitor = yield* Monitor.Service
      const sessionA = yield* seed()
      const sessionB = yield* seed()

      const a = yield* declare(sessionA, "session-a monitor")
      yield* declare(sessionB, "session-b monitor")

      const listA = yield* monitor.list(sessionA)
      expect(listA).toHaveLength(1)
      expect(listA[0]?.id).toBe(a.id)
    }),
  )

  it.effect("recover marks every starting/running row orphaned using only its stored status -- no PID, no process table, is ever consulted", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const monitor = yield* Monitor.Service
      const sessionID = yield* seed()

      const starting = yield* declare(sessionID, "was starting")
      const running = yield* declare(sessionID, "was running")
      const completed = yield* declare(sessionID, "already completed")

      // Force two rows into states a real runtime would have reached before this process died,
      // and one into a terminal state that must NOT be touched by recovery. Reaching into the
      // table directly is deliberate: PR1 has no execute/complete service method to drive a row
      // through these transitions, and recover() must not care how a row got here -- only what
      // its stored status says now.
      yield* db.update(MonitorTable).set({ status: "running" }).where(eq(MonitorTable.id, running.id)).run().pipe(Effect.orDie)
      yield* db.update(MonitorTable).set({ status: "completed" }).where(eq(MonitorTable.id, completed.id)).run().pipe(Effect.orDie)

      const orphaned = yield* monitor.recover()
      const orphanedIDs = orphaned.map((o) => o.id).sort()

      expect(orphanedIDs).toEqual([starting.id, running.id].sort())
      // TestClock starts at epoch 0, so this is exactly the case a truthy (rather than nullish)
      // check on time_finished would misread as unset -- a real timestamp of 0 is still a
      // timestamp.
      expect(orphaned.every((o) => o.time.finished !== undefined)).toBe(true)

      const stillCompleted = yield* monitor.get(completed.id)
      expect(stillCompleted?.status).toBe("completed")
    }),
  )

  it.effect("recover is idempotent -- a second pass over the same rows changes nothing further", () =>
    Effect.gen(function* () {
      const monitor = yield* Monitor.Service
      const sessionID = yield* seed()
      yield* declare(sessionID, "orphan me")

      const first = yield* monitor.recover()
      expect(first.length).toBeGreaterThan(0)

      const second = yield* monitor.recover()
      expect(second).toHaveLength(0)
    }),
  )

  it.effect("a stale previousStatus snapshot, published after a winning pass already moved the row, is rejected by the CAS -- and a plain refetch would have misreported it as this pass's own", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const monitor = yield* Monitor.Service
      const sessionID = yield* seed()
      const created = yield* declare(sessionID, "raced by two recover passes")

      // The snapshot a second concurrent recover() pass would have captured in its own scan,
      // before the winning pass below ran.
      const staleStatus = created.status // "starting"

      const winner = yield* monitor.recover()
      expect(winner.some((m) => m.id === created.id)).toBe(true)
      const afterWinner = yield* monitor.get(created.id)
      expect(afterWinner?.status).toBe("orphaned")

      // The second pass publishes against that stale snapshot -- exactly what its own recover()
      // loop body would do for this row. The event still commits (durable events are never
      // rejected), but projectOrphaned's CAS must not match: the row is no longer `staleStatus`.
      const stalePublish = yield* events.publish(MonitorEvent.Orphaned, {
        sessionID,
        monitorID: created.id,
        timestamp: yield* DateTime.now,
        previousStatus: staleStatus,
      })
      const afterStale = yield* monitor.get(created.id)

      // The CAS protects the row: untouched by the losing pass, still exactly the winner's revision.
      expect(afterStale?.revision).toBe(afterWinner?.revision)
      // And this is finding (1) made concrete: a plain, unconditional `get(row.id)` -- the bug --
      // STILL reports "orphaned" here, even though THIS publish did not cause it. recover() cannot
      // use that alone to decide "did I do this"; it must compare against the seq this exact
      // publish committed at, which the row's revision provably does not match.
      expect(afterStale?.status).toBe("orphaned")
      expect(stalePublish.durable).toBeDefined()
      expect(afterStale?.revision).not.toBe(stalePublish.durable!.seq + 1)
    }),
  )

  it.effect("8 genuinely concurrent recover passes over one stale row: exactly one reports it orphaned, never more -- deleting the CAS-return filter turns this red (observed: 8/8 double-counted it)", () =>
    Effect.gen(function* () {
      const monitor = yield* Monitor.Service
      const sessionID = yield* seed()
      const created = yield* declare(sessionID, "raced by many concurrent recover passes")

      // recover() cedes the scheduler between its scan and acting on it (see the Effect.yieldNow
      // in recover() itself), so these fibers' scans genuinely interleave with each other's
      // publishes -- unlike the sequential test above, whose second pass's own scan already
      // excludes the row and so never even attempts the CAS.
      const results = yield* Effect.all(Array.from({ length: 8 }, () => monitor.recover()), { concurrency: "unbounded" })
      const hits = results.filter((r) => r.some((m) => m.id === created.id)).length
      expect(hits).toBe(1)

      const final = yield* monitor.get(created.id)
      expect(final?.status).toBe("orphaned")
    }),
  )
})
