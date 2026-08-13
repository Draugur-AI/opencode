export * as MonitorProcess from "./process"

import { Duration, Effect, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import type { Monitor } from "@opencode-ai/schema/monitor"
import { AppProcess } from "../process"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { BashTool } from "../tool/bash"

export const MAX_CAPTURE_BYTES = 1024 * 1024
export const CAPABILITY = "monitor"

export type CheckResult =
  | { readonly type: "completed"; readonly exitCode: number; readonly output: string }
  | { readonly type: "timeout"; readonly output: string }

/**
 * TKT-392 interim (operator ruling, diary 2678): an unattended monitor must never block on a
 * prompt, so this uses `permission.ask()` (evaluates, non-blocking) rather than `permission.
 * assert()` (evaluates, then BLOCKS the caller on the pending request's reply for an "ask"
 * policy -- correct for an interactive tool call, wrong here). Fail-closed by construction: both
 * "deny" and "ask" refuse the check today. "ask" is not yet the parked/resume-on-approval state
 * Sean's ruling specifies (`waiting-on-user`, not `failed`) -- that needs its own Monitor.Status
 * value, a reactive resume-on-reply subscription, and an exactly-once identity for the parked
 * request, none of which exist yet. Filed as TKT-392, not silently accepted as the final shape.
 */
export class AuthorizationRefusedError extends Schema.TaggedErrorClass<AuthorizationRefusedError>()(
  "MonitorProcess.AuthorizationRefusedError",
  { action: Schema.String, effect: Schema.Literals(["deny", "ask"]) },
) {
  override get message() {
    if (this.effect === "ask")
      return `This tool's permission is "ask" for action "${this.action}"; monitors cannot prompt for approval. Set it to "allow", or approval-flow support arrives with TKT-392.`
    return `Permission denied for action "${this.action}".`
  }
}

const authorize = (permission: PermissionV2.Interface, input: PermissionV2.AssertInput) =>
  Effect.gen(function* () {
    const result = yield* permission.ask(input)
    if (result.effect === "allow") return
    return yield* new AuthorizationRefusedError({ action: input.action, effect: result.effect })
  })

/**
 * One check attempt for a command monitor. Reuses the foreground Bash tool's own Location and
 * permission logic rather than re-deriving it (diary 2435 §4) -- a second implementation of "may
 * this command run here" is how the two drift, and the drifting one is the one that runs
 * unattended every intervalMs. Requires BOTH the `monitor` capability and the same `bash` command
 * permission bash.ts itself asserts.
 *
 * Called fresh on every check, not once at declaration (TKT-322 diary 2669 permission ruling):
 * authorize per check, so a revoked permission takes effect at the very next check rather than a
 * monitor running forever on a decision made once at `monitor_create` time. This is load-bearing
 * on `runOne`'s own loop shape -- it must keep calling this per iteration rather than caching an
 * authorized/denied result across iterations -- see
 * monitor-runtime-execution.test.ts's "authorization is checked per check" test, which fails if
 * that caching is ever introduced.
 */
export const check = Effect.fn("MonitorProcess.check")(function* (input: {
  readonly monitorID: Monitor.ID
  readonly sessionID: Monitor.Info["sessionID"]
  readonly source: Monitor.CommandSource
  readonly timeoutMs: number
}) {
  const mutation = yield* LocationMutation.Service
  const permission = yield* PermissionV2.Service
  const appProcess = yield* AppProcess.Service

  const target = yield* mutation.resolve({ path: input.source.cwd ?? ".", kind: "directory" })
  const external = target.externalDirectory
  if (external)
    yield* authorize(permission, {
      ...LocationMutation.externalDirectoryPermission(external),
      sessionID: input.sessionID,
    })
  yield* authorize(permission, {
    action: CAPABILITY,
    resources: ["*"],
    sessionID: input.sessionID,
  })
  yield* authorize(permission, {
    action: "bash",
    resources: [input.source.command],
    sessionID: input.sessionID,
  })

  // Reuses bash.ts's own platform default rather than re-deriving it (Copilot review, #38): without
  // a shell, quotes/pipes/multi-word commands can silently parse differently, or not run at all,
  // even though this asserts the identical `bash` permission. Config-configured shell overrides
  // (bash.ts's own `entries().shell` lookup) are not threaded through here -- that would add
  // Config.Service to check()'s ambient requirements, which run-coordinator.ts's drain must stay
  // free of; out of scope for closing the "no shell at all" gap this fixes.
  const command = ChildProcess.make(input.source.command, [], {
    cwd: target.canonical,
    shell: BashTool.defaultShell(),
    stdin: "ignore",
    detached: process.platform !== "win32",
    forceKillAfter: Duration.seconds(3),
  })
  const result = yield* appProcess.run(command, {
    combineOutput: true,
    timeout: Duration.millis(input.timeoutMs),
    maxOutputBytes: MAX_CAPTURE_BYTES,
  })
  // TKT-409 (feedback #199): appProcess.run() now returns whatever bytes it captured before
  // the timeout fired (timedOut: true), not nothing -- the containment matrix (diary 2435 §3)
  // wants a timed-out check's partial output bounded and retained, which this satisfies:
  // MAX_CAPTURE_BYTES already bounds it via run()'s own maxOutputBytes.
  if (result.timedOut) return { type: "timeout", output: result.output?.toString("utf8") ?? "" } satisfies CheckResult
  return {
    type: "completed",
    exitCode: result.exitCode,
    output: result.output?.toString("utf8") ?? "",
  } satisfies CheckResult
})
