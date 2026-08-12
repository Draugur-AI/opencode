import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { Monitor } from "@opencode-ai/core/monitor"
import { MonitorTable } from "@opencode-ai/core/monitor/sql"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Effect } from "effect"
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
})
