export * as Monitor from "./monitor"

import { and, eq, inArray } from "drizzle-orm"
import { Context, DateTime, Effect, Layer } from "effect"
import { Monitor as MonitorSchema } from "@opencode-ai/schema/monitor"
import { MonitorEvent } from "@opencode-ai/schema/monitor-event"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { EventV2 } from "./event"
import type { SessionSchema } from "./session/schema"
import { MonitorTable } from "./monitor/sql"

type DatabaseService = Database.Interface["db"]

export const ID = MonitorSchema.ID
export type ID = typeof ID.Type
export const Status = MonitorSchema.Status
export type Status = typeof Status.Type
export const Source = MonitorSchema.Source
export type Source = typeof Source.Type
export const Condition = MonitorSchema.Condition
export type Condition = typeof Condition.Type
export const OutputPolicy = MonitorSchema.OutputPolicy
export type OutputPolicy = typeof OutputPolicy.Type
export const Info = MonitorSchema.Info
export type Info = MonitorSchema.Info

type Row = typeof MonitorTable.$inferSelect

const fromRow = (row: Row): Info => ({
  id: row.id,
  sessionID: row.session_id,
  title: row.title,
  source: row.source,
  intervalMs: row.interval_ms,
  timeoutMs: row.timeout_ms,
  condition: row.condition,
  status: row.status,
  attempt: row.attempt,
  maxAttempts: row.max_attempts ?? undefined,
  outputPolicy: row.output_policy,
  profileSnapshotID: row.profile_snapshot_id ?? undefined,
  time: {
    created: DateTime.makeUnsafe(row.time_created),
    started: row.time_started ? DateTime.makeUnsafe(row.time_started) : undefined,
    checked: row.time_checked ? DateTime.makeUnsafe(row.time_checked) : undefined,
    finished: row.time_finished ? DateTime.makeUnsafe(row.time_finished) : undefined,
  },
  revision: row.revision,
})

/**
 * Apply one committed `Created` event: the declaration row does not exist yet, so this is a plain
 * insert -- no compare-and-set needed. The row's `revision` is server-assigned from the durable
 * aggregate sequence (mirrors SessionGoal.projectUpdated), not the nominal value the publisher put
 * in the event payload.
 */
export const projectCreated = Effect.fn("Monitor.projectCreated")(function* (
  db: DatabaseService,
  input: {
    readonly info: Info
    readonly aggregateSeq: number
  },
) {
  const info = input.info
  yield* db
    .insert(MonitorTable)
    .values({
      id: info.id,
      session_id: info.sessionID,
      title: info.title,
      source: info.source,
      interval_ms: info.intervalMs,
      timeout_ms: info.timeoutMs,
      condition: info.condition,
      status: info.status,
      attempt: info.attempt,
      max_attempts: info.maxAttempts,
      output_policy: info.outputPolicy,
      profile_snapshot_id: info.profileSnapshotID,
      time_created: DateTime.toEpochMillis(info.time.created),
      revision: input.aggregateSeq + 1,
    })
    .run()
    .pipe(Effect.orDie)
})

/**
 * Apply one committed `Orphaned` event. Conditioned on the row still being in `previousStatus` --
 * `recover` fans out one event per stale row it read in one scan, and this compare-and-set makes
 * replaying (or a second concurrent recovery pass) a no-op rather than clobbering a status the row
 * has since moved past. A process ID is never consulted here or anywhere in this path (design
 * post; diary 2435 §1) -- only the row's own previously-read status decides.
 */
export const projectOrphaned = Effect.fn("Monitor.projectOrphaned")(function* (
  db: DatabaseService,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly monitorID: ID
    readonly previousStatus: Status
    readonly aggregateSeq: number
    readonly timestamp: DateTime.Utc
  },
) {
  yield* db
    .update(MonitorTable)
    .set({
      status: "orphaned",
      time_finished: DateTime.toEpochMillis(input.timestamp),
      revision: input.aggregateSeq + 1,
    })
    .where(
      and(
        eq(MonitorTable.id, input.monitorID),
        eq(MonitorTable.session_id, input.sessionID),
        eq(MonitorTable.status, input.previousStatus),
      ),
    )
    .run()
    .pipe(Effect.orDie)
})

export interface Interface {
  readonly create: (input: {
    readonly sessionID: SessionSchema.ID
    readonly title: string
    readonly source: Source
    readonly intervalMs: number
    readonly timeoutMs: number
    readonly condition: Condition
    readonly maxAttempts?: number
    readonly outputPolicy: OutputPolicy
    readonly profileSnapshotID?: string
  }) => Effect.Effect<Info>
  readonly list: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Info>>
  readonly get: (monitorID: ID) => Effect.Effect<Info | undefined>
  /**
   * Startup reconciliation: every row still `starting`/`running` is a monitor that was live in a
   * process that no longer exists (this process just started). Marks each `orphaned` and returns
   * the ones it changed. Never reads a PID to decide -- see projectOrphaned.
   */
  readonly recover: () => Effect.Effect<ReadonlyArray<Info>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Monitor") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service

    const get: Interface["get"] = Effect.fn("Monitor.get")(function* (monitorID) {
      const row = yield* db.select().from(MonitorTable).where(eq(MonitorTable.id, monitorID)).get().pipe(Effect.orDie)
      return row ? fromRow(row) : undefined
    })

    const list: Interface["list"] = Effect.fn("Monitor.list")(function* (sessionID) {
      const rows = yield* db
        .select()
        .from(MonitorTable)
        .where(eq(MonitorTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      return rows.map(fromRow)
    })

    const create: Interface["create"] = Effect.fn("Monitor.create")(function* (input) {
      const now = yield* DateTime.now
      const id = ID.create()
      const info: Info = {
        id,
        sessionID: input.sessionID,
        title: input.title,
        source: input.source,
        intervalMs: input.intervalMs,
        timeoutMs: input.timeoutMs,
        condition: input.condition,
        status: "starting",
        attempt: 0,
        maxAttempts: input.maxAttempts,
        outputPolicy: input.outputPolicy,
        profileSnapshotID: input.profileSnapshotID as Info["profileSnapshotID"],
        time: { created: now },
        revision: 0,
      }
      yield* events.publish(MonitorEvent.Created, {
        sessionID: input.sessionID,
        monitorID: id,
        timestamp: now,
        info,
      })
      const row = yield* get(id)
      if (!row) return yield* Effect.die(`Monitor projection missing for ${id} immediately after commit`)
      return row
    })

    const recover: Interface["recover"] = Effect.fn("Monitor.recover")(function* () {
      const now = yield* DateTime.now
      const stale = yield* db
        .select()
        .from(MonitorTable)
        .where(inArray(MonitorTable.status, ["starting", "running"]))
        .all()
        .pipe(Effect.orDie)
      const orphaned: Info[] = []
      for (const row of stale) {
        yield* events.publish(MonitorEvent.Orphaned, {
          sessionID: row.session_id,
          monitorID: row.id,
          timestamp: now,
          previousStatus: row.status,
        })
        const updated = yield* get(row.id)
        if (updated) orphaned.push(updated)
      }
      return orphaned
    })

    return Service.of({ get, list, create, recover })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [EventV2.node, Database.node] })
