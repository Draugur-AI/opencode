import { describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { AppProcess } from "@opencode-ai/core/process"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { buildLocationServiceMap, LocationServiceMap } from "@opencode-ai/core/location-services"
import { Monitor } from "@opencode-ai/core/monitor"
import { MonitorOutput } from "@opencode-ai/core/monitor/output"
import { MonitorRuntime } from "@opencode-ai/core/monitor/runtime"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionStore } from "@opencode-ai/core/session/store"

// The real dependency graph MonitorRuntime.layer needs to build -- deliberately the real
// services, not stubs, so this proves the ACTUAL construction dedupes rather than just a generic
// mechanism proxy (see test/effect/layer-node/layer-node.test.ts:349 for that proxy).
//
// TKT-322 diary 2669 review: MonitorRuntime resolves LocationMutation/PermissionV2 PER CHECK
// (through SessionStore + LocationServiceMap, mirroring SessionExecutionLocal's own
// `locations.get(session.location)`), not at construction -- so this test's construction-time
// deps are SessionStore + LocationServiceMap, not Location/LocationMutation/PermissionV2
// directly. `buildLocationServiceMap([])` is a real, self-contained LocationServiceMap.Service
// that never needs to actually resolve a location, since this test never calls start()/cancel().
const deps = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    EventV2.node,
    Monitor.node,
    MonitorOutput.node,
    AppProcess.node,
    SessionExecution.node,
    SessionStore.node,
    LocationServiceMap.node,
  ]),
  [
    [SessionExecution.node, SessionExecution.noopLayer],
    [LocationServiceMap.node, buildLocationServiceMap([])],
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
