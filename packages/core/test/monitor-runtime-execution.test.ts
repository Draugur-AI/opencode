import { afterAll, describe, expect } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { eq } from "drizzle-orm"
import { Deferred, Effect, Layer } from "effect"
import type { ChildProcess } from "effect/unstable/process"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { Monitor } from "@opencode-ai/core/monitor"
import { MonitorCheckTable } from "@opencode-ai/core/monitor/sql"
import { MonitorOutput } from "@opencode-ai/core/monitor/output"
import { MonitorRuntime } from "@opencode-ai/core/monitor/runtime"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AppProcess } from "@opencode-ai/core/process"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { testEffect } from "./lib/effect"

// ---------------------------------------------------------------------------
// Fakes -- scripted per test via the mutable state below, reset() first thing
// in every test body. Mirrors tool-bash.test.ts's own AppProcess/PermissionV2
// fakes: a single scripted outcome plus a call log, not a full real process.
// ---------------------------------------------------------------------------

let runImpl: (
  command: ChildProcess.Command,
  options?: AppProcess.RunOptions,
) => Effect.Effect<AppProcess.RunResult, AppProcess.AppProcessError> = () => Effect.die("run() not scripted for this test")
const runs: Array<{ readonly command: string }> = []
let denyAction: string | undefined
const assertions: PermissionV2.AssertInput[] = []
const wakes: SessionV2.ID[] = []

const reset = () => {
  runs.length = 0
  assertions.length = 0
  wakes.length = 0
  denyAction = undefined
  runImpl = () => Effect.die("run() not scripted for this test")
}

const locationMutation = Layer.succeed(
  LocationMutation.Service,
  LocationMutation.Service.of({
    // No test here needs an external-directory approval path -- MonitorProcess.check only reads
    // `.canonical`/`.externalDirectory`, and every scenario's command runs "inside" the location.
    resolve: () => Effect.succeed({ canonical: "/fake-cwd", resource: "." }),
  }),
)

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(
          input.action === denyAction ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void,
        ),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const appProcess = Layer.succeed(
  AppProcess.Service,
  AppProcess.Service.of({
    run: (command: ChildProcess.Command, options?: AppProcess.RunOptions) =>
      Effect.suspend(() => {
        runs.push({ command: command._tag === "StandardCommand" ? command.command : "piped" })
        return runImpl(command, options)
      }),
  } as unknown as AppProcess.Interface),
)

const sessionExecution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set()),
    resume: () => Effect.die("unused"),
    wake: (sessionID) => Effect.sync(() => void wakes.push(sessionID)),
    interrupt: () => Effect.die("unused"),
  }),
)

const outputData = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-runtime-exec-test-"))
afterAll(() => fs.rmSync(outputData, { recursive: true, force: true }))

// Database/EventV2/SessionProjector/Monitor/MonitorOutput are the REAL services -- this is what
// makes these tests prove the full loop (event publish -> projector -> table), not just
// runtime.ts in isolation. Only the process boundary (AppProcess), authorization
// (PermissionV2), path resolution (LocationMutation) and the sibling session-execution wake
// (SessionExecution) are faked, matching tool-bash.test.ts's own choice of fake boundary.
const deps = Layer.mergeAll(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, Monitor.node, MonitorOutput.node]),
    [[Global.node, Global.layerWith({ data: outputData })]],
  ),
  locationMutation,
  permission,
  appProcess,
  sessionExecution,
)

const it = testEffect(Layer.provideMerge(MonitorRuntime.layer, deps))

let seq = 0
const seed = () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const id = SessionV2.ID.make(`ses_monitor_runtime_${seq++}`)
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

const declare = (
  sessionID: SessionV2.ID,
  overrides: Partial<{
    readonly condition: Monitor.Condition
    readonly maxAttempts: number
    readonly outputPolicy: Monitor.OutputPolicy
    readonly intervalMs: number
    readonly timeoutMs: number
  }> = {},
) =>
  Effect.gen(function* () {
    const monitor = yield* Monitor.Service
    return yield* monitor.create({
      sessionID,
      title: "watch build",
      source: { type: "command", command: "the-fake-appprocess-ignores-this" },
      intervalMs: overrides.intervalMs ?? 1000,
      timeoutMs: overrides.timeoutMs ?? 5000,
      condition: overrides.condition ?? { type: "exit-code", expect: 0 },
      maxAttempts: overrides.maxAttempts,
      outputPolicy: overrides.outputPolicy ?? {},
    })
  })

const succeed = (input: { readonly exitCode?: number; readonly output?: string } = {}) =>
  Effect.succeed({
    command: "mock",
    exitCode: input.exitCode ?? 0,
    output: Buffer.from(input.output ?? ""),
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    outputTruncated: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  } satisfies AppProcess.RunResult)

const timedOut = () =>
  Effect.fail(new AppProcess.AppProcessError({ command: "mock", cause: new Error("Timed out") }))

describe("MonitorRuntime execution loop", () => {
  it.effect("permission-denied-before-start: no process is spawned, no check row is written, the monitor fails", () =>
    Effect.gen(function* () {
      reset()
      denyAction = "bash"
      const runtime = yield* MonitorRuntime.Service
      const monitorObj = yield* Monitor.Service
      const { db } = yield* Database.Service
      const sessionID = yield* seed()
      const created = yield* declare(sessionID)

      yield* runtime.start(created.id)

      expect(runs).toHaveLength(0)
      const after = yield* monitorObj.get(created.id)
      expect(after?.status).toBe("failed")
      const checks = yield* db.select().from(MonitorCheckTable).where(eq(MonitorCheckTable.monitor_id, created.id)).all().pipe(Effect.orDie)
      expect(checks).toHaveLength(0)
    }),
  )

  it.effect("timeout: the check is recorded as not-triggered with no exit code, and the loop completes at maxAttempts", () =>
    Effect.gen(function* () {
      reset()
      runImpl = timedOut
      const runtime = yield* MonitorRuntime.Service
      const monitorObj = yield* Monitor.Service
      const { db } = yield* Database.Service
      const sessionID = yield* seed()
      const created = yield* declare(sessionID, { maxAttempts: 1 })

      yield* runtime.start(created.id)

      expect(runs).toHaveLength(1)
      const after = yield* monitorObj.get(created.id)
      expect(after?.status).toBe("completed")
      const checks = yield* db.select().from(MonitorCheckTable).where(eq(MonitorCheckTable.monitor_id, created.id)).all().pipe(Effect.orDie)
      expect(checks).toHaveLength(1)
      expect(checks[0]?.exit_code).toBeNull()
      expect(checks[0]?.triggered).toBe(false)
      expect(checks[0]?.detail).toBe("timed out before completion")
    }),
  )

  it.effect("trigger-delivered-once: publishes exactly one external-signal message and wakes the session exactly once", () =>
    Effect.gen(function* () {
      reset()
      runImpl = () => succeed({ exitCode: 0 })
      const runtime = yield* MonitorRuntime.Service
      const monitorObj = yield* Monitor.Service
      const { db } = yield* Database.Service
      const sessionID = yield* seed()
      const created = yield* declare(sessionID)

      yield* runtime.start(created.id)

      const after = yield* monitorObj.get(created.id)
      expect(after?.status).toBe("triggered")
      const messageID = SessionMessage.ID.make(`msg_monitor_${created.id}_0`)
      const messages = yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, messageID)).all().pipe(Effect.orDie)
      expect(messages).toHaveLength(1)
      expect(wakes).toEqual([sessionID])
    }),
  )

  it.effect("wake delivery is idempotent: a pre-existing message for the same check is not duplicated and does not re-wake", () =>
    Effect.gen(function* () {
      reset()
      runImpl = () => succeed({ exitCode: 0 })
      const runtime = yield* MonitorRuntime.Service
      const monitorObj = yield* Monitor.Service
      const { db } = yield* Database.Service
      const sessionID = yield* seed()
      const created = yield* declare(sessionID)
      const messageID = SessionMessage.ID.make(`msg_monitor_${created.id}_0`)

      // Simulates the state Delta 2's exactly-once guarantee is meant to make impossible in
      // practice -- the deterministic id already occupied before this monitor's own first
      // delivery. deliver()'s existence check must skip cleanly rather than crash on the
      // primary-key collision an unconditional insert would hit (diary 2435 §2).
      yield* db
        .insert(SessionMessageTable)
        .values({ id: messageID, session_id: sessionID, type: "synthetic", seq: 999, time_created: 0, data: {} as never })
        .run()
        .pipe(Effect.orDie)

      yield* runtime.start(created.id)

      const after = yield* monitorObj.get(created.id)
      expect(after?.status).toBe("triggered")
      const messages = yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, messageID)).all().pipe(Effect.orDie)
      expect(messages).toHaveLength(1)
      expect(wakes).toHaveLength(0)
    }),
  )

  it.effect("cancel-during-check: interrupting an in-flight check marks the monitor cancelled and writes no check row", () =>
    Effect.gen(function* () {
      reset()
      const reached = yield* Deferred.make<void>()
      runImpl = () => Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never))
      const runtime = yield* MonitorRuntime.Service
      const monitorObj = yield* Monitor.Service
      const { db } = yield* Database.Service
      const sessionID = yield* seed()
      const created = yield* declare(sessionID)

      yield* Effect.forkScoped(runtime.start(created.id))
      yield* Deferred.await(reached)
      yield* runtime.cancel(created.id)

      const after = yield* monitorObj.get(created.id)
      expect(after?.status).toBe("cancelled")
      const checks = yield* db.select().from(MonitorCheckTable).where(eq(MonitorCheckTable.monitor_id, created.id)).all().pipe(Effect.orDie)
      expect(checks).toHaveLength(0)
    }),
  )

  it.effect("output-overflow: a check whose output exceeds the policy is truncated to a tail preview with the full text in managed storage", () =>
    Effect.gen(function* () {
      reset()
      const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n")
      runImpl = () => succeed({ exitCode: 1, output: big }) // exitCode 1 -- does not match the expect:0 condition
      const runtime = yield* MonitorRuntime.Service
      const { db } = yield* Database.Service
      const sessionID = yield* seed()
      const created = yield* declare(sessionID, {
        maxAttempts: 1,
        outputPolicy: { maxLines: 5, maxBytes: 200 },
      })

      yield* runtime.start(created.id)

      const checks = yield* db.select().from(MonitorCheckTable).where(eq(MonitorCheckTable.monitor_id, created.id)).all().pipe(Effect.orDie)
      expect(checks).toHaveLength(1)
      const row = checks[0]!
      expect(row.triggered).toBe(false)
      expect(row.object_ref).toBeTruthy()
      expect(row.tail_preview?.split("\n").length).toBeLessThanOrEqual(5)
      expect(row.tail_preview).toContain("line 499")
      const written = yield* Effect.promise(() => fs.promises.readFile(row.object_ref!, "utf-8"))
      expect(written).toBe(big)
    }),
  )
})
