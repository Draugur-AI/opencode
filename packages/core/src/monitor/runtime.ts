export * as MonitorRuntime from "./runtime"

import { eq } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Result, Schema, Stream } from "effect"
import { Monitor as MonitorSchema } from "@opencode-ai/schema/monitor"
import { MonitorEvent } from "@opencode-ai/schema/monitor-event"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { LocationServiceMap } from "../location-service-map"
import { Monitor } from "../monitor"
import { MonitorCheckTable } from "./sql"
import { MonitorCondition } from "./condition"
import { MonitorOutput } from "./output"
import { MonitorProcess } from "./process"
import { AppProcess } from "../process"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { SessionExecution } from "../session/execution"
import { SessionRunCoordinator } from "../session/run-coordinator"
import { SessionStore } from "../session/store"
import { SessionMessageTable } from "../session/sql"

/**
 * The port's own typed failure: no live MonitorRuntime in this assembly. TKT-322 diary 2530 Delta
 * 1: modeled on McpRuntime (TKT-323), NOT on SessionExecution's `LayerNode.unbound` shape --
 * `LayerNode.compile` throws on an unbound node and takes the WHOLE compiled bundle down with it,
 * not just the consumer that reached it. Absence lives in the value (this error), never a
 * compile-time crash. `node` below is a BOUND default that always fails this; `liveNode` supplies
 * the real implementation as a REPLACEMENT wherever an assembly wants live monitor execution.
 */
export class UnavailableError extends Schema.TaggedErrorClass<UnavailableError>()(
  "MonitorRuntime.UnavailableError",
  {},
) {}

// A monitor's owning session was not found when a check was due (e.g. purged between declaration
// and this check). Not `Effect.die`: the session genuinely may no longer exist, a real race, not
// a programmer error -- runOne's generic Result.isFailure handling turns this into a Failed event
// like any other check failure.
export class SessionMissingError extends Schema.TaggedErrorClass<SessionMissingError>()(
  "MonitorRuntime.SessionMissingError",
  { sessionID: Schema.String },
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

const triggerMessageID = (monitorID: MonitorSchema.ID, checkSeq: number) =>
  SessionMessage.ID.make(`msg_monitor_${monitorID}_${checkSeq}`)

// Terminal-per-monitor (runOne returns immediately after either path), so unlike the trigger id
// this never needs a checkSeq to stay unique.
const failureMessageID = (monitorID: MonitorSchema.ID) => SessionMessage.ID.make(`msg_monitor_${monitorID}_failed`)

/**
 * TKT-322 diary 2530 Delta 2: `MonitorRuntime` owns live OS processes, so "process-global" must be
 * an exactly-once instance across every build that reaches it, or two runtimes mean two PID maps
 * and two owners of the same children -- cancel silently misses, recovery marks the wrong monitors
 * orphaned. Open question 3 (schedule vs borrow the coordinator): this owns ITS OWN
 * `SessionRunCoordinator` instance (same factory `SessionExecutionLocal` uses, a fresh instance,
 * NOT a shared one) -- states its instance count structurally (one coordinator per MonitorRuntime
 * construction) and is provable by the same construction-counter test pattern TKT-349 landed,
 * applied to this layer (see monitor/runtime.test.ts). This omission is load-bearing on that
 * guarantee, not just an optimization: if this ever constructs more than once per process, two
 * coordinators race the same monitors with no lock between them.
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const monitor = yield* Monitor.Service
    const output = yield* MonitorOutput.Service
    const sessionExecution = yield* SessionExecution.Service
    const sessionStore = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const appProcess = yield* AppProcess.Service

    // Resolves LocationMutation/PermissionV2 PER CHECK, for the monitor's OWN session's location
    // -- not once at construction (diary 2669 review, TKT-322 permission ruling: authorize per
    // check, so a revoked permission takes effect at the next wake, not only at declaration).
    // Mirrors SessionExecutionLocal's own `locations.get(session.location)` pattern exactly: a
    // single MonitorRuntime instance serves every location in the process, so binding ONE
    // location's services at construction (PR #38's original shape) was correct only in a
    // single-location test harness and silently wrong for any second location. A stale session
    // read here fails the check via SessionMissingError rather than dying -- the session may have
    // been purged since the last check, a real race, not a programmer error.
    const check = (input: Parameters<typeof MonitorProcess.check>[0]) =>
      Effect.gen(function* () {
        const session = yield* sessionStore.get(input.sessionID)
        if (!session) return yield* new SessionMissingError({ sessionID: input.sessionID })
        return yield* MonitorProcess.check(input).pipe(
          Effect.provide(locations.get(session.location)),
          Effect.provideService(AppProcess.Service, appProcess),
        )
      })

    const coordinator = yield* SessionRunCoordinator.make<MonitorSchema.ID, never>({
      drain: (monitorID) => runOne(monitorID),
    })

    // The one path that starts a declared monitor's check loop, reactive rather than caller-driven
    // (TKT-322 diary 2669, Ethan's ruling): a tool call, a future non-tool declaration path, or
    // anything else that publishes MonitorEvent.Created all reach this the same way, and a new
    // assembly that wires MonitorRuntime gets it automatically -- no separate "remember to also
    // call start()" step to forget. Same shape as plugin/models-dev.ts's own
    // `events.subscribe(...).pipe(Stream.runForEach(...), Effect.forkScoped({startImmediately}))`,
    // the established precedent for a global service reacting to a live event stream.
    yield* events.subscribe(MonitorEvent.Created).pipe(
      Stream.runForEach((event) =>
        coordinator
          .run(event.data.info.id)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logError("monitor failed to start from Created event", { monitorID: event.data.info.id, cause }),
            ),
          ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )

    // Shared by the trigger and failure paths: deliver a synthetic message + wake, idempotently.
    // Idempotent by construction (diary 2435 §2): the deterministic id collides on
    // SessionMessageTable's primary key for a duplicate, so a proactive existence check is enough
    // -- MonitorRuntime's own exactly-once guarantee (Delta 2) means no other actor can be
    // mid-publish for the same id concurrently.
    const notify = Effect.fn("MonitorRuntime.notify")(function* (input: {
      readonly info: Monitor.Info
      readonly checkSeq: number
      readonly messageID: SessionMessage.ID
      readonly text: string
    }) {
      const existing = yield* db
        .select({ id: SessionMessageTable.id })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, input.messageID))
        .get()
        .pipe(Effect.orDie)
      if (existing) return
      const now = yield* DateTime.now
      yield* events.publish(SessionEvent.ExternalSignal, {
        sessionID: input.info.sessionID,
        timestamp: now,
        messageID: input.messageID,
        monitorID: input.info.id,
        checkSeq: input.checkSeq,
        title: input.info.title,
        text: input.text,
      })
      yield* sessionExecution.wake(input.info.sessionID)
    })

    // TKT-392 interim requirement: a failure must wake and notify like a trigger does, or it is a
    // silent skip from the owning session's point of view -- reasons include an authorization
    // refusal that names its own remedy (MonitorProcess.AuthorizationRefusedError.message).
    const publishFailed = Effect.fn("MonitorRuntime.publishFailed")(function* (info: Monitor.Info, reason: string) {
      const now = yield* DateTime.now
      yield* events.publish(MonitorEvent.Failed, { sessionID: info.sessionID, monitorID: info.id, timestamp: now, reason })
      yield* notify({
        info,
        checkSeq: info.attempt,
        messageID: failureMessageID(info.id),
        text: `Monitor "${info.title}" failed: ${reason}`,
      })
    })

    const runOne = Effect.fn("MonitorRuntime.runOne")(function* (monitorID: MonitorSchema.ID) {
      let info = yield* monitor.get(monitorID)
      if (!info) return
      if (info.status !== "starting" && info.status !== "running") return

      if (info.source.type !== "command") {
        yield* publishFailed(info, "plugin monitors are not executable in this slice")
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
          yield* publishFailed(info, message)
          return
        }
        const result = outcome.success
        // TKT-409: both CheckResult variants carry output -- a timed-out check's captured
        // bytes (process.ts's own new timedOut:true contract) must reach output.bound() the
        // same as a completed check's, or the containment design's "partial output bounded
        // and retained" (diary 2435 §3) never actually happens past MonitorProcess.check.
        // TKT-409: both CheckResult variants carry output -- a timed-out check's captured
        // bytes (process.ts's own new timedOut:true contract) must reach output.bound() the
        // same as a completed check's, or the containment design's "partial output bounded
        // and retained" (diary 2435 §3) never actually happens past MonitorProcess.check.
        const rawOutput = result.output
        const evaluation =
          result.type === "completed"
            ? MonitorCondition.evaluate(info.condition, { exitCode: result.exitCode, output: result.output })
            : { triggered: false, detail: "timed out before completion" }
        const boundResult = yield* output.bound({ text: rawOutput, policy: info.outputPolicy }).pipe(Effect.result)
        if (Result.isFailure(boundResult)) {
          const detail =
            boundResult.failure.cause instanceof Error ? boundResult.failure.cause.message : String(boundResult.failure.cause)
          yield* publishFailed(info, `Failed to store check output: ${detail}`)
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
          yield* notify({
            info,
            checkSeq,
            messageID: triggerMessageID(info.id, checkSeq),
            text: `Monitor "${info.title}" triggered: ${evaluation.detail}`,
          })
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
          // Interrupt BEFORE reading status (Copilot review, #38): coordinator.interrupt() blocks
          // until the drain fiber is fully settled, so a read taken first can go stale if the
          // drain reaches a terminal status (triggered/completed/failed) in the window between
          // that read and the interrupt -- publishing Cancelled against the stale snapshot would
          // then clobber the real terminal status projectStatus's unconditional update has no CAS
          // to catch. Reading only after interrupt() returns means the status is never stale.
          yield* coordinator.interrupt(monitorID)
          const info = yield* monitor.get(monitorID)
          if (!info || (info.status !== "starting" && info.status !== "running")) return
          const now = yield* DateTime.now
          yield* events.publish(MonitorEvent.Cancelled, { sessionID: info.sessionID, monitorID, timestamp: now })
        }),
    })
  }),
)

/**
 * The real implementation, reachable only as a `[node, liveNode]` replacement -- never wired in
 * directly, so an assembly that forgets it keeps the safe bound default rather than silently
 * getting a second instance. `LocationServiceMap.node` is unbound itself (per-location services
 * are built lazily, keyed by Location.Ref) -- an assembly wiring this in must supply that
 * replacement too, same as `SessionExecution.node`'s.
 */
export const liveNode = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    Database.node,
    EventV2.node,
    Monitor.node,
    MonitorOutput.node,
    SessionExecution.node,
    SessionStore.node,
    LocationServiceMap.node,
    AppProcess.node,
  ],
})
