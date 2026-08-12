import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, ManagedRuntime, Scope } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

class Value extends Context.Service<Value, { readonly value: string }>()("test/LayerNodeValue") {}
class Greeting extends Context.Service<Greeting, { readonly value: string }>()("test/LayerNodeGreeting") {}
class Left extends Context.Service<Left, { readonly value: string }>()("test/LayerNodeLeft") {}
class Right extends Context.Service<Right, { readonly value: string }>()("test/LayerNodeRight") {}
class Database extends Context.Service<Database, { readonly name: string }>()("test/GraphDatabase") {}
class Users extends Context.Service<Users, { readonly list: Effect.Effect<string[]> }>()("test/GraphUsers") {}
class App extends Context.Service<App, { readonly run: Effect.Effect<string[]> }>()("test/GraphApp") {}

const tags = LayerNode.tags({ app: [] })
const make = tags.make("app")
const build = <A, E>(root: LayerNode.Node<A, E, any>, replacements?: readonly LayerNode.Replacement[]) =>
  LayerNode.compile(root, replacements) as Layer.Layer<A, E>
const valueLayer = Layer.succeed(Value, Value.of({ value: "production" }))
const greetingLayer = Layer.effect(
  Greeting,
  Effect.map(Value, (value) => Greeting.of({ value: `hello ${value.value}` })),
)
const value = make({ service: Value, layer: valueLayer, deps: [] })
const greeting = make({ service: Greeting, layer: greetingLayer, deps: [value] })

describe("layer node", () => {
  test("builds an untagged graph", async () => {
    const value = LayerNode.make({ service: Value, layer: valueLayer, deps: [] })
    const greeting = LayerNode.make({ service: Greeting, layer: greetingLayer, deps: [value] })
    const program = Effect.map(Greeting, (item) => item.value).pipe(
      Effect.provide(LayerNode.compile(LayerNode.group([greeting]))),
    )
    expect(await Effect.runPromise(program)).toBe("hello production")
  })

  test("builds a dependency graph", async () => {
    const program = Effect.map(Greeting, (item) => item.value).pipe(Effect.provide(build(LayerNode.group([greeting]))))
    expect(await Effect.runPromise(program)).toBe("hello production")
  })

  test("exposes roots but hides transitive dependencies", () => {
    const layer = build(LayerNode.group([greeting]))
    const check: Layer.Layer<Greeting> = layer
    void check
  })

  test("preserves branch-specific implementations across roots", async () => {
    const firstValue = make({ service: Value, layer: Layer.succeed(Value, Value.of({ value: "first" })), deps: [] })
    const secondValue = make({ service: Value, layer: Layer.succeed(Value, Value.of({ value: "second" })), deps: [] })
    const leftLayer = Layer.effect(
      Left,
      Effect.map(Value, (item) => Left.of({ value: item.value })),
    )
    const rightLayer = Layer.effect(
      Right,
      Effect.map(Value, (item) => Right.of({ value: item.value })),
    )
    const left = make({ service: Left, layer: leftLayer, deps: [firstValue] })
    const right = make({ service: Right, layer: rightLayer, deps: [secondValue] })
    const layer = build(LayerNode.group([left, right]))
    const program = Effect.gen(function* () {
      return [(yield* Left).value, (yield* Right).value]
    }).pipe(Effect.provide(layer))
    expect(await Effect.runPromise(program)).toEqual(["first", "second"])
  })

  test("requires unbound nodes to be replaced before compilation", async () => {
    const unbound = LayerNode.unbound(Value, tags.values.app)
    const greeting = make({ service: Greeting, layer: greetingLayer, deps: [unbound] })
    const tree = LayerNode.group([greeting])
    expect(() => LayerNode.compile(tree)).toThrow("Unbound layer node: test/LayerNodeValue")
    const layer = LayerNode.compile(tree, [[unbound, value]]) as Layer.Layer<Greeting>
    const program = Effect.map(Greeting, (item) => item.value).pipe(Effect.provide(layer))
    expect(await Effect.runPromise(program)).toBe("hello production")
  })

  test("replaces a node with a closed layer", async () => {
    const replacement = Layer.succeed(Value, Value.of({ value: "simulation" }))
    const program = Effect.map(Greeting, (item) => item.value).pipe(
      Effect.provide(build(LayerNode.group([greeting]), [[value, replacement]])),
    )
    expect(await Effect.runPromise(program)).toBe("hello simulation")
  })

  test("replaces every use of the same layer", async () => {
    const leftLayer = Layer.effect(
      Left,
      Effect.map(Value, (item) => Left.of({ value: item.value })),
    )
    const rightLayer = Layer.effect(
      Right,
      Effect.map(Value, (item) => Right.of({ value: item.value })),
    )
    const left = make({ service: Left, layer: leftLayer, deps: [value] })
    const right = make({ service: Right, layer: rightLayer, deps: [value] })
    const replacement = Layer.succeed(Value, Value.of({ value: "replaced" }))
    const layer = build(LayerNode.group([left, right]), [[value, replacement]])
    const program = Effect.gen(function* () {
      return [(yield* Left).value, (yield* Right).value]
    }).pipe(Effect.provide(layer))
    expect(await Effect.runPromise(program)).toEqual(["replaced", "replaced"])
  })

  test("does not acquire an unused replacement", async () => {
    let acquisitions = 0
    const other = make({ service: Left, layer: Layer.succeed(Left, Left.of({ value: "other" })), deps: [] })
    const replacement = Layer.effect(
      Left,
      Effect.sync(() => {
        acquisitions++
        return Left.of({ value: "replacement" })
      }),
    )
    await Effect.runPromise(
      Effect.map(Greeting, (item) => item.value).pipe(
        Effect.provide(build(LayerNode.group([greeting]), [[other, replacement]])),
      ),
    )
    expect(acquisitions).toBe(0)
  })

  test("replaces a node without acquiring its dependencies", async () => {
    let acquisitions = 0
    const dependencyLayer = Layer.effect(
      Value,
      Effect.sync(() => {
        acquisitions++
        return Value.of({ value: "dependency" })
      }),
    )
    const dependency = make({ service: Value, layer: dependencyLayer, deps: [] })
    const original = make({ service: Greeting, layer: greetingLayer, deps: [dependency] })
    const replacement = make({
      service: Greeting,
      layer: Layer.succeed(Greeting, Greeting.of({ value: "replacement" })),
      deps: [],
    })

    const program = Effect.map(Greeting, (item) => item.value).pipe(
      Effect.provide(build(LayerNode.group([original]), [[original, replacement]])),
    )

    expect(await Effect.runPromise(program)).toBe("replacement")
    expect(acquisitions).toBe(0)
  })

  test("applies later replacements inside earlier replacement nodes", async () => {
    const original = make({ service: Greeting, layer: greetingLayer, deps: [value] })
    const replacement = make({ service: Greeting, layer: greetingLayer, deps: [value] })
    const program = Effect.map(Greeting, (item) => item.value).pipe(
      Effect.provide(
        build(LayerNode.group([original]), [
          [original, replacement],
          [value, Layer.succeed(Value, Value.of({ value: "replacement dependency" }))],
        ]),
      ),
    )

    expect(await Effect.runPromise(program)).toBe("hello replacement dependency")
  })

  test("hoists and compiles tagged graphs", async () => {
    const tags = LayerNode.tags({ location: ["global"], global: [] })
    const global = tags.make("global")
    const location = tags.make("location")
    const database = global({
      service: Database,
      layer: Layer.succeed(Database, Database.of({ name: "Alice" })),
      deps: [],
    })
    const users = location({
      service: Users,
      layer: Layer.effect(
        Users,
        Effect.gen(function* () {
          const db = yield* Database
          return Users.of({ list: Effect.succeed([db.name]) })
        }),
      ),
      deps: [database],
    })
    const app = location({
      service: App,
      layer: Layer.effect(
        App,
        Effect.gen(function* () {
          const service = yield* Users
          return App.of({ run: service.list })
        }),
      ),
      deps: [users],
    })

    const result = LayerNode.hoist(LayerNode.group([app]), tags.values.global)
    expect(result.node.dependencies[0]?.dependencies[0]?.dependencies[0]).toMatchObject({
      kind: "group",
      dependencies: [],
    })
    expect(result.hoisted.dependencies).toEqual([database])

    const layer = LayerNode.compile(result.node).pipe(
      Layer.provide(LayerNode.compile(result.hoisted)),
    ) as unknown as Layer.Layer<App>
    const program = Effect.gen(function* () {
      return yield* (yield* App).run
    }).pipe(Effect.provide(layer))

    expect(await Effect.runPromise(program)).toEqual(["Alice"])
  })

  test("rejects conflicting hoisted implementations", () => {
    const tags = LayerNode.tags({ location: ["global"], global: [] })
    const global = tags.make("global")
    const location = tags.make("location")
    const first = global({
      service: Database,
      layer: Layer.succeed(Database, Database.of({ name: "first" })),
      deps: [],
    })
    const second = global({
      service: Database,
      layer: Layer.succeed(Database, Database.of({ name: "second" })),
      deps: [],
    })
    const left = location({
      service: Users,
      layer: Layer.effect(Users, Effect.as(Database, Users.of({ list: Effect.succeed([]) }))),
      deps: [first],
    })
    const right = location({
      service: App,
      layer: Layer.effect(App, Effect.as(Database, App.of({ run: Effect.succeed([]) }))),
      deps: [second],
    })

    expect(() => LayerNode.hoist(LayerNode.group([left, right]), tags.values.global)).toThrow(
      "Tag global has conflicting implementations for test/GraphDatabase",
    )
  })

  test("treats dependency groups as transparent while hoisting", () => {
    const tags = LayerNode.tags({ location: ["global"], global: [] })
    const global = tags.make("global")
    const location = tags.make("location")
    const database = global({
      service: Database,
      layer: Layer.succeed(Database, Database.of({ name: "Alice" })),
      deps: [],
    })
    const users = location({
      service: Users,
      layer: Layer.effect(Users, Effect.as(Database, Users.of({ list: Effect.succeed([]) }))),
      deps: [LayerNode.group([database])],
    })
    const result = LayerNode.hoist(LayerNode.group([users]), tags.values.global)

    expect(result.node.dependencies[0]?.dependencies[0]?.dependencies[0]).toMatchObject({
      kind: "group",
      dependencies: [],
    })
  })

  // TKT-349: a "process singleton" node is a singleton PER MEMO MAP, not per process. Two
  // independent compile() calls that each reach the same node -- mirroring server.ts's two
  // separate AppNodeBuilderV1.build(...) calls that both reach SessionV2.node -- construct it
  // TWICE unless both builds share one MemoMap. No functional assertion catches this (each half
  // of the split still behaves correctly in isolation); only a construction counter does. This
  // is the regression shape for that bug class, not a reproduction of the specific
  // SessionExecutionLocal coordinator it surfaced on.
  test("a node reached from two separate compile() calls constructs once with a shared MemoMap, twice without", async () => {
    let constructions = 0
    const counted = LayerNode.make({
      service: Value,
      layer: Layer.effect(
        Value,
        Effect.sync(() => {
          constructions++
          return Value.of({ value: "shared" })
        }),
      ),
      deps: [],
    })
    const left = LayerNode.make({
      service: Left,
      layer: Layer.effect(
        Left,
        Effect.map(Value, (item) => Left.of({ value: item.value })),
      ),
      deps: [counted],
    })
    const right = LayerNode.make({
      service: Right,
      layer: Layer.effect(
        Right,
        Effect.map(Value, (item) => Right.of({ value: item.value })),
      ),
      deps: [counted],
    })
    // Two SEPARATE compile() calls, each reaching `counted` through its own dependency edge --
    // the exact shape of server.ts's SessionV2.node build and its separate `app` group build
    // both reaching SessionExecution.node.
    const leftLayer = LayerNode.compile(LayerNode.group([left])) as Layer.Layer<Left>
    const rightLayer = LayerNode.compile(LayerNode.group([right])) as Layer.Layer<Right>

    constructions = 0
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Scope.Scope
          // Each build gets its OWN fresh MemoMap -- the unshared case (server.ts's original
          // bug, before the harness/acp riders in this PR).
          yield* Layer.buildWithMemoMap(leftLayer, Layer.makeMemoMapUnsafe(), scope)
          yield* Layer.buildWithMemoMap(rightLayer, Layer.makeMemoMapUnsafe(), scope)
        }),
      ),
    )
    expect(constructions).toBe(2)

    constructions = 0
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Scope.Scope
          const sharedMemoMap = Layer.makeMemoMapUnsafe()
          yield* Layer.buildWithMemoMap(leftLayer, sharedMemoMap, scope)
          yield* Layer.buildWithMemoMap(rightLayer, sharedMemoMap, scope)
        }),
      ),
    )
    expect(constructions).toBe(1)
  })

  // TKT-349, ACP half: sharing one MemoMap dedupes a process-global node's construction across
  // two "connections" (like acp/service.ts's Provider/Agent/Command/InstanceStore, reached
  // through Directory.node), but must NOT dedupe a value that is legitimately different per
  // connection -- Directory.loaderNode is a fresh `Layer.succeed(Directory.Loader, ...)` built
  // inside `makeDirectoryService(sdk)` on every call, closing over that call's own `sdk`, and has
  // to stay distinct per sdk even though it shares the same MemoMap as the process-global deps
  // beside it. Probed by hand before the fix with exactly this shape; this is that probe made
  // permanent.
  //
  // 🛑 This test proves the underlying Effect SEMANTICS (ManagedRuntime + MemoMap sharing behave
  // this way in general) -- it does not touch `makeSessionService`/`makeDirectoryService`, so
  // deleting `{ memoMap }` from those two acp/service.ts sites would NOT turn this test red. It
  // is a correctness proof for the mechanism the fix relies on, not a regression guard for the
  // fix itself. The guard that DOES fail if the fix is reverted is
  // `test/acp/service-session.test.ts`'s "shares the process-global directory deps across
  // connections when the memo map is shared, and does not when it isn't" -- that one calls the
  // real `ACPService.make()` twice and counts real provider-loader invocations.
  test("a shared MemoMap dedupes a same-reference global layer but never a fresh per-call Layer.succeed", async () => {
    let constructions = 0
    // One module-level-style layer reference, reused across every call below -- mirrors
    // Provider.node et al. being the SAME `Layer.effect(...)` object no matter how many times
    // AppNodeBuilder.build() is invoked.
    const globalLayer = Layer.effect(
      Value,
      Effect.sync(() => {
        constructions++
        return Value.of({ value: `build#${constructions}` })
      }),
    )
    const buildGlobal = (memoMap: Layer.MemoMap) =>
      ManagedRuntime.make(globalLayer, { memoMap }).runSync(Effect.andThen(Value, (s) => Effect.succeed(s)))

    // WITHOUT sharing: each call gets its own fresh MemoMap -- the same-reference layer
    // constructs once PER CALL. This is the arm the original version of this test skipped
    // straight past -- without it, "constructions === 1" only shows sharing CAN dedupe, not that
    // dedup is CAUSED by sharing rather than by something else about the layer itself.
    constructions = 0
    buildGlobal(Layer.makeMemoMapUnsafe())
    buildGlobal(Layer.makeMemoMapUnsafe())
    expect(constructions).toBe(2)

    // WITH sharing: same layer reference, one MemoMap across both calls -- constructs once.
    constructions = 0
    const sharedMemoMap = Layer.makeMemoMapUnsafe()
    buildGlobal(sharedMemoMap)
    buildGlobal(sharedMemoMap)
    expect(constructions).toBe(1)

    // Same shared MemoMap, but each call passes its OWN Layer.succeed object -- exactly what
    // makeDirectoryService(sdk) does with Directory.Loader on every invocation. Must stay
    // distinct even though the map is shared.
    const buildPerCall = (v: string) =>
      ManagedRuntime.make(Layer.succeed(Value, Value.of({ value: v })), { memoMap: sharedMemoMap }).runSync(
        Effect.andThen(Value, (s) => Effect.succeed(s)),
      )
    const a = buildPerCall("sdk-A")
    const b = buildPerCall("sdk-B")
    expect(a.value).toBe("sdk-A")
    expect(b.value).toBe("sdk-B")
  })
})
