export * as McpCatalog from "./mcp-catalog"

import { Context, Effect, Layer } from "effect"
import { McpCatalog as McpCatalogSchema } from "@opencode-ai/schema/mcp-catalog"
import { makeLocationNode } from "../effect/app-node"
import { ConfigDocument } from "./document"

export const Status = McpCatalogSchema.Status
export type Status = McpCatalogSchema.Status

export const Entry = McpCatalogSchema.Entry
export type Entry = McpCatalogSchema.Entry

export interface Interface {
  /** Servers declared across this location's config documents. Chunk 1 (TKT-323) has no live MCP
   * runtime to query -- see Entry's status doc -- so this reads purely from
   * `ConfigDocument.effective()`. */
  readonly list: () => Effect.Effect<Entry[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/McpCatalog") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const documents = yield* ConfigDocument.Service

    const list: Interface["list"] = Effect.fn("McpCatalog.list")(function* () {
      const { fields } = yield* documents.effective()
      const mcp = fields.mcp?.value as { servers?: Record<string, { type: "local" | "remote"; disabled?: boolean }> } | undefined
      const source = fields.mcp?.source
      if (!mcp?.servers || !source) return []

      return Object.entries(mcp.servers).map(
        ([name, server]) =>
          new Entry({
            name,
            transport: server.type,
            status: server.disabled ? "disabled" : "configured",
            target: source,
          }),
      )
    })

    return Service.of({ list })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [ConfigDocument.node] })
