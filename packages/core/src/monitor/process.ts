export * as MonitorProcess from "./process"

import { Duration, Effect } from "effect"
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
 * One check attempt for a command monitor. Reuses the foreground Bash tool's own Location and
 * permission logic rather than re-deriving it (diary 2435 §4) -- a second implementation of "may
 * this command run here" is how the two drift, and the drifting one is the one that runs
 * unattended every intervalMs. Requires BOTH the `monitor` capability and the same `bash` command
 * permission bash.ts itself asserts.
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
    yield* permission.assert({
      ...LocationMutation.externalDirectoryPermission(external),
      sessionID: input.sessionID,
    })
  yield* permission.assert({
    action: CAPABILITY,
    resources: ["*"],
    sessionID: input.sessionID,
  })
  yield* permission.assert({
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
  const result = yield* appProcess
    .run(command, {
      combineOutput: true,
      timeout: Duration.millis(input.timeoutMs),
      maxOutputBytes: MAX_CAPTURE_BYTES,
    })
    .pipe(
      Effect.catchTag("AppProcessError", (error) =>
        error.cause instanceof Error && error.cause.message === "Timed out"
          ? Effect.succeed(undefined)
          : Effect.fail(error),
      ),
    )
  // KNOWN GAP, inherited from bash.ts (same shape there: appProcess.run() on timeout returns
  // nothing, not partial output) rather than Monitor-specific: the containment matrix (diary 2435
  // §3) wants "partial output bounded and retained" on timeout; this returns none. Fixing it means
  // switching to appProcess.runStream() with a caller-side accumulator, a change to shared
  // AppProcess behavior that bash.ts would benefit from too -- out of scope for reusing its
  // existing run() path in this slice. Filed as feedback #199, not silently accepted as done.
  if (!result) return { type: "timeout", output: "" } satisfies CheckResult
  return {
    type: "completed",
    exitCode: result.exitCode,
    output: result.output?.toString("utf8") ?? "",
  } satisfies CheckResult
})
