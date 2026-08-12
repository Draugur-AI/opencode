export * as McpRuntimeLive from "./runtime"

import { Effect, Layer, Option } from "effect"
import { McpRuntime } from "@opencode-ai/core/config/mcp-runtime"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { Location } from "@opencode-ai/core/location"
import { MCP } from "./index"
import { InstanceStore } from "@/project/instance-store"

/**
 * The real implementation of core's McpRuntime port: a thin projection over this package's own
 * live MCP.Service, which is already in this assembly's tree (see httpapi/server.ts's `app` and
 * app-runtime.ts's `AppLayer`, both of which already build MCP.node directly). Supplied as the
 * [McpRuntime.node, McpRuntimeLive.node] replacement tuple at those two sites only -- packages/cli
 * and packages/sdk-next have no MCP.Service to project, so they keep McpRuntime.node's own bound
 * default (always fails `UnavailableError`, never unbound -- see the port's own doc for why an
 * unbound member is fatal to a shared group, not merely absent), which the mcp.status handler
 * maps to `ServiceUnavailableError` over the wire (TKT-323 chunk 2).
 *
 * MCP.Service's own methods (status() included) are scoped via the LEGACY InstanceState
 * mechanism -- they die with "InstanceRef not provided" without it in context. The v2 request
 * pipeline this adapter lives in carries directory via Location.Service instead (LocationQuery),
 * a genuinely different, not-yet-unified addressing scheme -- see FORK.md's divergence ledger.
 * This adapter is the designated impedance-matching point between the two: it derives InstanceRef
 * from the current Location.Service directory using InstanceStore.Service.provide, the SAME
 * primitive httpapi/server.ts's own instanceContextLayer middleware calls internally for the
 * legacy path-embedded routes (`middleware/instance-context.ts`'s provideInstanceContext ->
 * `store.load(...)` -> `Effect.provideService(InstanceRef, ctx)`), not a reimplementation of it.
 * When legacy addressing eventually retires, this bridge dies with the adapter, contained here.
 *
 * Final shape, Ethan's ruling on Henry's TKT-323 diary 2503/2511/2512: earlier attempts pulled a
 * graph dependency into `locationServices`'s compile (a `deps:` entry on MCP.node or
 * InstanceStore.node -- fatal to the whole per-location bundle, not just this node, the same
 * class of failure the port's own bound-default now exists to prevent) or rebuilt a fresh,
 * duplicate instance via a second AppNodeBuilder.build call (the ACP/memoMap defect in a closure,
 * invisible to graph analysis). This is neither: a plain `Layer.succeed` (R = never, nothing to
 * satisfy, `deps: []` is honest) whose `status()` method reads MCP.Service/InstanceStore.Service/
 * Location.Service via `Effect.serviceOption` INSIDE the method body, at real request time, from
 * whatever ambient Context the httpapi assembly's `app` build (which already holds the one true
 * instance of each) has already merged in -- never a static requirement, never a rebuild. Same
 * in-repo idiom as `tool-output-store.ts:117`/`truncate.ts:76`. Verified via a probe (this exact
 * scenario passing, per Ethan's hard precondition) before this was built out, not assumed.
 */
const layer = Layer.succeed(
  McpRuntime.Service,
  McpRuntime.Service.of({
    status: () =>
      Effect.gen(function* () {
        const mcp = yield* Effect.serviceOption(MCP.Service)
        const store = yield* Effect.serviceOption(InstanceStore.Service)
        const location = yield* Effect.serviceOption(Location.Service)
        if (Option.isNone(mcp) || Option.isNone(store) || Option.isNone(location))
          return yield* Effect.die(
            new Error(
              "McpRuntimeLive: MCP.Service/InstanceStore.Service/Location.Service not ambiently present at request time -- this adapter is wired only where they should already be",
            ),
          )
        return yield* store.value.provide({ directory: location.value.directory }, mcp.value.status())
      }),
  }),
)

export const node = makeLocationNode({ service: McpRuntime.Service, layer, deps: [] })
