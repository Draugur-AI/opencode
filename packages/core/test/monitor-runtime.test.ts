import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppProcess } from "@opencode-ai/core/process"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { Monitor } from "@opencode-ai/core/monitor"
import { MonitorOutput } from "@opencode-ai/core/monitor/output"
import { MonitorRuntime } from "@opencode-ai/core/monitor/runtime"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionProfile } from "@opencode-ai/core/session/profile"
import { SessionStore } from "@opencode-ai/core/session/store"
import { location } from "./fixture/location"

// LocationMutation.node's layer resolves the directory's real path at construction, so this
// needs to be a directory that actually exists on disk (unlike PermissionV2 alone, which never
// touches the filesystem).
const projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-runtime-test-"))
afterAll(() => fs.rmSync(projectDirectory, { recursive: true, force: true }))

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(projectDirectory) })),
)

// The real dependency graph MonitorRuntime.layer needs to build -- deliberately the real
// services (per permission.test.ts's own working list), not stubs, so this proves the ACTUAL
// construction dedupes rather than just a generic mechanism proxy (see
// test/effect/layer-node/layer-node.test.ts:349 for that proxy).
const deps = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    EventV2.node,
    Monitor.node,
    MonitorOutput.node,
    LocationMutation.node,
    PermissionV2.node,
    AppProcess.node,
    SessionExecution.node,
    SessionStore.node,
    PermissionSaved.node,
    AgentV2.node,
    SessionProfile.node,
  ]),
  [
    [Location.node, current],
    [SessionExecution.node, SessionExecution.noopLayer],
  ],
)

// One module-level reference, reused across every build below -- mirrors every real assembly
// site reaching the SAME `MonitorRuntime.layer` object no matter how many times it does so.
const merged = Layer.provideMerge(MonitorRuntime.layer, deps)

const build = (memoMap: Layer.MemoMap) =>
  ManagedRuntime.make(merged, { memoMap }).runPromise(Effect.andThen(MonitorRuntime.Service, (s) => Effect.succeed(s)))

describe("MonitorRuntime.layer construction", () => {
  // TKT-322 diary 2530 Delta 2, REQUIRED acceptance criterion: MonitorRuntime owns live OS
  // processes, so two builds reaching it must not construct it twice unless they deliberately
  // share a MemoMap -- two PID maps and two owners of the same children means cancel silently
  // misses and recovery marks the wrong monitors orphaned.
  //
  // Correctness-load-bearing, not just a regression guard: `Monitor.projectStatus` (monitor.ts)
  // skips a compare-and-set specifically BECAUSE this guarantee holds -- weaken what this test
  // asserts and that no-CAS decision silently stops being safe, with nothing left to catch it.
  test("two builds sharing one MemoMap construct MonitorRuntime exactly once; two builds without sharing construct it twice", async () => {
    // Unshared: each build gets its own fresh MemoMap -- the same-reference layer constructs
    // once PER BUILD, producing two independently-built Service instances. Without this arm,
    // "same instance when shared" alone wouldn't show sharing CAUSED the dedupe rather than
    // something else about the layer.
    const [a1, a2] = await Promise.all([build(Layer.makeMemoMapUnsafe()), build(Layer.makeMemoMapUnsafe())])
    expect(a1).not.toBe(a2)

    // Shared: same MonitorRuntime.layer reference, one MemoMap across both builds -- constructs
    // once. This is the real-process shape: every assembly site that reaches MonitorRuntime
    // through the process's one shared MemoMap gets the SAME runtime instance.
    const sharedMemoMap = Layer.makeMemoMapUnsafe()
    const [b1, b2] = await Promise.all([build(sharedMemoMap), build(sharedMemoMap)])
    expect(b1).toBe(b2)
  })
})
