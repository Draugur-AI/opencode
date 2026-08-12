export * as McpRuntime from "./mcp-runtime"

import { Context, Effect, Layer, Schema } from "effect"
import { McpStatus } from "@opencode-ai/schema/mcp-status"
import { makeLocationNode } from "../effect/app-node"

export const Status = McpStatus.Status
export type Status = McpStatus.Status

/**
 * The port's own typed failure: no live MCP runtime in this assembly. Not a fabricated status --
 * "disabled" is a state a user believes they can toggle, and that is not the truth here (Ethan's
 * ruling, TKT-323). Mapped to `ServiceUnavailableError` (503) by the handler, which is what a
 * client actually sees; this stays the port-to-handler contract.
 */
export class UnavailableError extends Schema.TaggedErrorClass<UnavailableError>()(
  "McpRuntime.UnavailableError",
  {},
) {}

/**
 * Narrow port onto whichever live MCP connections this assembly actually owns -- status only,
 * not the full MCP.Service surface (add/connect/auth/etc). packages/core cannot reach the live
 * connection itself (packages/opencode owns it, wrong dependency direction to import directly),
 * so this is a TAG only; the real implementation is supplied as a replacement layer at whichever
 * packages/opencode assembly site actually has a live MCP.Service in its tree (TKT-323 chunk 2).
 *
 * BOUND to a default that always fails `UnavailableError`, deps: [] -- NOT `LayerNode.unbound`.
 * `locationServices` (packages/core/src/location-services.ts) is compiled by more than one
 * assembly (`buildLocationServiceMap`'s `LayerMap.make`, one merged layer per location); an
 * unbound member is fatal to EVERY assembly that does not supply a replacement, not absent-and-
 * skippable -- `LayerNode.compile` throws on any unbound node and takes the whole per-location
 * bundle down with it, including routes that touch nothing MCP-shaped. Observed twice on this
 * ticket, two different unbound nodes: see FORK.md's divergence ledger and Henry's TKT-323 diary
 * 2503/2512 for the full mechanism and the four-experiment ladder that found it. The real
 * implementation is supplied as a REPLACEMENT for this bound default (packages/opencode/src/mcp/
 * runtime.ts's McpRuntimeLive), exactly as it would replace an unbound node -- replacements
 * substitute either kind the same way.
 */
export interface Interface {
  readonly status: () => Effect.Effect<Record<string, Status>, UnavailableError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/McpRuntime") {}

const defaultLayer = Layer.succeed(
  Service,
  Service.of({
    status: () => Effect.fail(new UnavailableError()),
  }),
)

export const node = makeLocationNode({ service: Service, layer: defaultLayer, deps: [] })
