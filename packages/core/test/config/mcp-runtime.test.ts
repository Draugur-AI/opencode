import { describe, expect } from "bun:test"
import { Cause, Context, Effect, Exit, Layer, Option } from "effect"
import { McpRuntime } from "@opencode-ai/core/config/mcp-runtime"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

describe("McpRuntime", () => {
  // TKT-323 chunk 2: McpRuntime.node MUST compile without a replacement -- it lives in
  // packages/core/src/location-services.ts's locationServices group, which more than one
  // assembly compiles, and an UNBOUND member there is fatal to the WHOLE per-location bundle for
  // every route in that assembly, not just the one that needed the member (67 failures from one
  // instance of this, 12 from another, both on this same ticket -- see Henry's TKT-323 diary
  // 2503/2512). This test is the regression guard for that whole incident: if McpRuntime.node
  // ever goes back to LayerNode.unbound, this is the first thing that fails.
  it.effect("compiles without a replacement, and the default fails UnavailableError, not a fabricated status", () =>
    Effect.gen(function* () {
      const built = AppNodeBuilder.build(LayerNode.group([McpRuntime.node]))
      const exit = yield* Effect.provide(Effect.gen(function* () {
        const runtime = yield* McpRuntime.Service
        return yield* runtime.status()
      }), built).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit))
        expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBeInstanceOf(McpRuntime.UnavailableError)
    }))

  it.effect("a supplied replacement overrides the bound default, same as it would an unbound node", () =>
    Effect.gen(function* () {
      const stub = makeLocationNode({
        service: McpRuntime.Service,
        layer: Layer.succeed(
          McpRuntime.Service,
          McpRuntime.Service.of({
            status: () => Effect.succeed({ example: { status: "connected" } }),
          }),
        ),
        deps: [],
      })
      const built = AppNodeBuilder.build(LayerNode.group([McpRuntime.node]), [[McpRuntime.node, stub]])
      const status = yield* Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* McpRuntime.Service
          return yield* runtime.status()
        }),
        built,
      )
      expect(status).toEqual({ example: { status: "connected" } })
    }))

  // TKT-323 chunk 2, Ethan's ruling: the same instrument that caught the SessionExecutionLocal
  // split-brain (TKT-349), applied to this ticket's shape. McpRuntimeLive reads MCP.Service and
  // InstanceStore.Service via `Effect.serviceOption` INSIDE its status() method body, never via a
  // `deps:` graph edge -- the whole point being that it reuses whatever single instance the
  // httpapi assembly's `app` build already constructed, rather than building its own. This proves
  // that reuse actually holds: a global-analog service built once via one compile (standing in
  // for `app`), and a second, SEPARATE compile (standing in for `locationServices`) whose only
  // node reads that same service ambiently, share a memoMap and construct the underlying service
  // exactly once when merged -- not twice, which would be a live, silently duplicated MCP.Service
  // or InstanceStore.Service, invisible to every functional assertion (see FORK.md's
  // "process singleton is a singleton per MemoMap" entry, TKT-349).
  it.effect("an ambient serviceOption read reuses the sibling compile's instance, not a second one", () =>
    Effect.gen(function* () {
      let constructions = 0
      class Global extends Context.Service<Global, { value: string }>()("test/McpRuntime/Global") {}
      const globalLayer = Layer.effect(
        Global,
        Effect.sync(() => {
          constructions++
          return Global.of({ value: "shared" })
        }),
      )

      const globalNode = LayerNode.make({ service: Global, layer: globalLayer, deps: [] })
      // Stands in for `app`'s LayerNode.group([..., MCP.node, ..., InstanceStore.node, ...]):
      // a direct, tracked consumer of the global service.
      const appTree = LayerNode.compile(LayerNode.group([globalNode])) as Layer.Layer<Global>

      // Stands in for locationServices' McpRuntime.node: reads the SAME tag via serviceOption,
      // deps: [] -- no graph edge to globalNode at all, exactly McpRuntimeLive's own shape.
      const ambientLayer = Layer.succeed(
        McpRuntime.Service,
        McpRuntime.Service.of({
          status: () =>
            Effect.gen(function* () {
              const global = yield* Effect.serviceOption(Global)
              return { seen: { status: Option.isSome(global) ? "connected" : "disabled" } }
            }),
        }),
      )
      const locationTree = LayerNode.compile(
        LayerNode.group([makeLocationNode({ service: McpRuntime.Service, layer: ambientLayer, deps: [] })]),
      ) as Layer.Layer<McpRuntime.Service>

      // Both "sides" of the real composition consume the global service in one execution --
      // app's own direct dependent, and McpRuntime's status() via serviceOption -- exactly how
      // createRoutes()'s own pipe merges locationServiceMapV2 and AppNodeBuilderV1.build(app)
      // into ONE overall Layer, built once at server startup. No manual memoMap threading is
      // needed here: a single Effect execution memoizes a layer's construction across everywhere
      // it's provided within that one run, which is what this asserts.
      constructions = 0
      yield* Effect.gen(function* () {
        yield* Global
        const runtime = yield* McpRuntime.Service
        yield* runtime.status()
      }).pipe(Effect.provide(locationTree), Effect.provide(appTree))

      expect(constructions).toBe(1)
    }))
})
