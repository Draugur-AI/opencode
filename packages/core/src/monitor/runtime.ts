export * as MonitorRuntime from "./runtime"

import { eq } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Result, Schema } from "effect"
import { Monitor as MonitorSchema } from "@opencode-ai/schema/monitor"
import { MonitorEvent } from "@opencode-ai/schema/monitor-event"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Monitor } from "../monitor"
import { MonitorCheckTable } from "./sql"
import { MonitorCondition } from "./condition"
import { MonitorOutput } from "./output"
import { MonitorProcess } from "./process"
import { AppProcess } from "../process"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { SessionExecution } from "../session/execution"
import { SessionRunCoordinator } from "../session/run-coordinator"
import { SessionMessageTable } from "../session/sql"

/**
 * The port's own typed failure: no live MonitorRuntime in this assembly. TKT-322 diary 2530 Delta
 * 1: modeled on McpRuntime (TKT-323), NOT on SessionExecution's `LayerNode.unbound` shape --
 * `LayerNode.compile` throws on an unbound node and takes the WHOLE compiled bundle down with it,
 * not just the consumer that reached it. Absence lives in the value (this error), never a
 * compile-time crash. `node` below is a BOUND default that always fails this; the real
 * implementation (`layer` in this module) is supplied as a REPLACEMENT wherever an assembly
 * actually wants live monitor execution -- not wired into any assembly by this PR (mirrors
 * Monitor.node's own "absent by decision" status from PR1: nothing calls create() from a
 * user-facing surface yet, so nothing needs a live runtime to react to it either).
 */
export class UnavailableError extends Schema.TaggedErrorClass<UnavailableError>()(
  "MonitorRuntime.UnavailableError",
  {},
) {}

export interface Interface {
  /** Starts (or joins, if already running) the check loop for a declared monitor. */
  readonly start: (monitorID: MonitorSchema.ID) => Effect.Effect<void, UnavailableError>
  /** Stops an active check loop and marks the monitor cancelled. Idle is a no-op. */
  readonly cancel: (monitorID: MonitorSchema.ID) => Effect.Effect<void, UnavailableError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/MonitorRuntime") {}

const defaultLayer = Layer.succeed(
  Service,
  Service.of({
    start: () => Effect.fail(new UnavailableError()),
    cancel: () => Effect.fail(new UnavailableError()),
  }),
)

export const node = makeGlobalNode({ service: Service, layer: defaultLayer, deps: [] })

const messageID = (monitorID: MonitorSchema.ID, checkSeq: number) =>
  SessionMessage.ID.make(`msg_monitor_${monitorID}_${checkSeq}`)

/**
 * TKT-322 diary 2530 Delta 2: `MonitorRuntime` owns live OS processes, so "process-global" must be
 * an exactly-once instance across every build that reaches it, or two runtimes mean two PID maps
 * and two owners of the same children -- cancel silently misses, recovery marks the wrong monitors
 * orphaned. Open question 3 (schedule vs borrow the coordinator): this owns ITS OWN
 * `SessionRunCoordinator` instance (same factory `SessionExecutionLocal` uses, a fresh instance,
 * NOT a shared one) -- states its instance count structurally (one coordinator per MonitorRuntime
 * construction) and is provable by the same construction-counter test pattern TKT-349 landed,
 * applied to this layer (see monitor/runtime.test.ts).
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const monitor = yield* Monitor.Service
    const output = yield* MonitorOutput.Service
    const sessionExecution = yield* SessionExecution.Service
    const mutation = yield* LocationMutation.Service
    const permission = yield* PermissionV2.Service
    const appProcess = yield* AppProcess.Service

    // SessionRunCoordinator.make's drain must be fully self-contained (Effect<void, E>, R
    // defaulted to never) -- MonitorProcess.check ambiently requires LocationMutation/
    // PermissionV2/AppProcess, so those are discharged here, once, rather than threaded as
    // parameters through every call site.
    const check = (input: Parameters<typeof MonitorProcess.check>[0]) =>
      MonitorProcess.check(input).pipe(
        Effect.provideService(LocationMutation.Service, mutation),
        Effect.provideService(PermissionV2.Service, permission),
        Effect.provideService(AppProcess.Service, appProcess),
      )

    const coordinator = yield* SessionRunCoordinator.make<MonitorSchema.ID, never>({
      drain: (monitorID) => runOne(monitorID),
    })

    const deliver = Effect.fn("MonitorRuntime.deliver")(function* (input: {
      readonly info: Monitor.Info
      readonly checkSeq: number
      readonly detail: string
    }) {
      const id = messageID(input.info.id, input.checkSeq)
      const existing = yield* db
        .select({ id: SessionMessageTable.id })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, id))
        .get()
        .pipe(Effect.orDie)
      // Idempotent by construction (diary 2435 §2): the deterministic id above collides on
      // SessionMessageTable's primary key for a duplicate (monitorID, checkSeq), so a proactive
      // existence check is enough -- MonitorRuntime's own exactly-once guarantee (Delta 2) means
      // no other actor can be mid-publish for the same pair concurrently.
      if (existing) return
      const now = yield* DateTime.now
      yield* events.publish(SessionEvent.ExternalSignal, {
        sessionID: input.info.sessionID,
        timestamp: now,
        messageID: id,
        monitorID: input.info.id,
        checkSeq: input.checkSeq,
        title: input.info.title,
        text: `Monitor "${input.info.title}" triggered: ${input.detail}`,
      })
      yield* sessionExecution.wake(input.info.sessionID)
    })

    const runOne = Effect.fn("MonitorRuntime.runOne")(function* (monitorID: MonitorSchema.ID) {
      let info = yield* monitor.get(monitorID)
      if (!info) return
      if (info.status !== "starting" && info.status !== "running") return

      if (info.source.type !== "command") {
        yield* publishFailed(events, info, "plugin monitors are not executable in this slice")
        return
      }
      const source = info.source

      if (info.status === "starting") {
        const now = yield* DateTime.now
        yield* events.publish(MonitorEvent.Started, { sessionID: info.sessionID, monitorID, timestamp: now })
        const refreshed = yield* monitor.get(monitorID)
        if (!refreshed) return
        info = refreshed
      }

      while (true) {
        const checkSeq = info.attempt
        const outcome = yield* check({
          monitorID,
          sessionID: info.sessionID,
          source,
          timeoutMs: info.timeoutMs,
        }).pipe(Effect.result)

        if (Result.isFailure(outcome)) {
          const message = outcome.failure instanceof Error ? outcome.failure.message : String(outcome.failure)
          yield* publishFailed(events, info, message)
          return
        }
        const result = outcome.success
        const rawOutput = result.type === "completed" ? result.output : ""
        const evaluation =
          result.type === "completed"
            ? MonitorCondition.evaluate(info.condition, { exitCode: result.exitCode, output: result.output })
            : { triggered: false, detail: "timed out before completion" }
        const boundResult = yield* output.bound({ text: rawOutput, policy: info.outputPolicy }).pipe(Effect.result)
        if (Result.isFailure(boundResult)) {
          const detail =
            boundResult.failure.cause instanceof Error ? boundResult.failure.cause.message : String(boundResult.failure.cause)
          yield* publishFailed(events, info, `Failed to store check output: ${detail}`)
          return
        }
        const bound = boundResult.success

        const checkNow = yield* DateTime.now
        yield* db
          .insert(MonitorCheckTable)
          .values({
            id: MonitorSchema.CheckID.create(),
            monitor_id: monitorID,
            session_id: info.sessionID,
            check_seq: checkSeq,
            time_created: DateTime.toEpochMillis(checkNow),
            exit_code: result.type === "completed" ? result.exitCode : undefined,
            triggered: evaluation.triggered,
            detail: evaluation.detail,
            tail_preview: bound.preview,
            checksum: bound.checksum,
            bytes: bound.bytes,
            object_ref: bound.objectRef,
          })
          .run()
          .pipe(Effect.orDie)
        yield* events.publish(MonitorEvent.Checked, {
          sessionID: info.sessionID,
          monitorID,
          timestamp: checkNow,
          checkSeq,
          triggered: evaluation.triggered,
        })

        if (evaluation.triggered) {
          yield* events.publish(MonitorEvent.Triggered, {
            sessionID: info.sessionID,
            monitorID,
            timestamp: checkNow,
            checkSeq,
            result: evaluation.detail,
          })
          yield* deliver({ info, checkSeq, detail: evaluation.detail })
          return
        }

        const refreshed = yield* monitor.get(monitorID)
        if (!refreshed || refreshed.status !== "running") return
        info = refreshed
        if (info.maxAttempts !== undefined && info.attempt >= info.maxAttempts) {
          const now = yield* DateTime.now
          yield* events.publish(MonitorEvent.Completed, { sessionID: info.sessionID, monitorID, timestamp: now })
          return
        }
        yield* Effect.sleep(`${info.intervalMs} millis`)
      }
    })

    return Service.of({
      start: (monitorID) => coordinator.run(monitorID).pipe(Effect.mapError(() => new UnavailableError())),
      cancel: (monitorID) =>
        Effect.gen(function* () {
          const info = yield* monitor.get(monitorID)
          yield* coordinator.interrupt(monitorID)
          if (!info || (info.status !== "starting" && info.status !== "running")) return
          const now = yield* DateTime.now
          yield* events.publish(MonitorEvent.Cancelled, { sessionID: info.sessionID, monitorID, timestamp: now })
        }),
    })
  }),
)

const publishFailed = (events: EventV2.Interface, info: Monitor.Info, reason: string) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now
    yield* events.publish(MonitorEvent.Failed, { sessionID: info.sessionID, monitorID: info.id, timestamp: now, reason })
  })
