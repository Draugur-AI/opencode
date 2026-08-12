import { describe, expect } from "bun:test"
import { Cause, Context, Effect, Exit, Layer, Option, Scope } from "effect"
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

  // TKT-323 chunk 2, Ethan's ruling, corrected per Henry's review: the same instrument that
  // caught the SessionExecutionLocal split-brain (TKT-349), applied to this ticket's shape.
  //
  // The FIRST version of this test asserted constructions === 1 with `globalNode` reachable from
  // only ONE compiled group (appTree) and `locationTree` reading it purely via
  // `Effect.serviceOption`, never as a graph member. That is not a guard: with no second
  // construction site anywhere in the test, the assertion reads 1 whether or not memoMap sharing
  // works at all -- it cannot go red. A construction-counter test asserts the DEDUPED count AND
  // the SPLIT count, or it is not a guard (see FORK.md's canonical pattern line). Fixed by putting
  // the SAME global node in BOTH compiled groups -- matching TKT-349's own Left/Right shape
  // exactly -- and asserting both sides: constructions === 1 under a shared MemoMap, === 2 under
  // separate ones.
  it.effect("a node reachable from two separate compiles constructs once shared, twice split", () =>
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

      // Stands in for `app`'s LayerNode.group([..., MCP.node, ..., InstanceStore.node, ...]): a
      // direct, tracked consumer of the global service.
      const appNode = LayerNode.make({
        service: McpRuntime.Service,
        layer: Layer.succeed(McpRuntime.Service, McpRuntime.Service.of({ status: () => Effect.succeed({}) })),
        deps: [globalNode],
      })
      const appLayer = LayerNode.compile(LayerNode.group([appNode])) as Layer.Layer<McpRuntime.Service>

      // Stands in for `locationServices`' McpRuntime.node reaching the SAME global service via a
      // second, independent compile -- the shape this test actually needs to distinguish deduped
      // from split, not the ambient-serviceOption shape McpRuntimeLive itself uses (that shape has
      // no graph edge to duplicate in the first place; this test is the standing guard for the
      // mechanism the ambient read relies on, not a re-test of McpRuntimeLive's own code).
      const locationNode = LayerNode.make({
        service: McpRuntime.Service,
        layer: Layer.succeed(McpRuntime.Service, McpRuntime.Service.of({ status: () => Effect.succeed({}) })),
        deps: [globalNode],
      })
      const locationLayer = LayerNode.compile(LayerNode.group([locationNode])) as Layer.Layer<McpRuntime.Service>

      constructions = 0
      yield* Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Scope.Scope
          // Each build gets its OWN fresh MemoMap -- the unshared case.
          yield* Layer.buildWithMemoMap(appLayer, Layer.makeMemoMapUnsafe(), scope)
          yield* Layer.buildWithMemoMap(locationLayer, Layer.makeMemoMapUnsafe(), scope)
        }),
      )
      expect(constructions).toBe(2)

      constructions = 0
      yield* Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Scope.Scope
          const sharedMemoMap = Layer.makeMemoMapUnsafe()
          yield* Layer.buildWithMemoMap(appLayer, sharedMemoMap, scope)
          yield* Layer.buildWithMemoMap(locationLayer, sharedMemoMap, scope)
        }),
      )
      expect(constructions).toBe(1)
    }))
})
