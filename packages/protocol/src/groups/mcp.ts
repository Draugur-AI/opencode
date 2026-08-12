import { McpCatalog } from "@opencode-ai/schema/mcp-catalog"
import { McpStatus } from "@opencode-ai/schema/mcp-status"
import { Location } from "@opencode-ai/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ServiceUnavailableError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

// Chunk 1 (TKT-323): declared-server catalog only, no live connection status -- see
// McpCatalog.Status's doc. Writes go through the config-document group's generic patch endpoints
// (an mcp.server.set/remove Patch), not a bespoke add/remove/connect/disconnect surface here, so
// this group and config-document never drift into two different notions of "what changed."
export const McpGroup = HttpApiGroup.make("server.mcp")
  .add(
    HttpApiEndpoint.get("mcp.list", "/api/mcp", {
      query: LocationQuery,
      success: Location.response(Schema.Array(McpCatalog.Entry)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.mcp.list",
          summary: "List MCP servers",
          description: "Servers declared across this location's config documents.",
        }),
      ),
  )
  .add(
    // Chunk 2 (TKT-323): live connection status, a separate endpoint from mcp.list rather than
    // enriching Entry -- the catalog answers unconditionally from config; this one needs an
    // assembly that actually owns a live MCP connection (packages/opencode's httpapi server and
    // AppLayer; NOT packages/cli's `serve` or packages/sdk-next, neither of which have one in
    // their dependency tree). ServiceUnavailableError (503) is the wire shape for that case --
    // never a fabricated status ("disabled" is a state a user believes they can toggle, and that
    // is not the truth here). The port itself (`@opencode-ai/core/config/mcp-runtime`) types this
    // as its own McpRuntime.UnavailableError on `status()`'s error channel; the handler
    // (`@opencode-ai/server/handlers/mcp`) maps that tagged error to this ServiceUnavailableError
    // exhaustively -- the two are the same fact at two layers, not two independent contracts.
    HttpApiEndpoint.get("mcp.status", "/api/mcp/status", {
      query: LocationQuery,
      success: Location.response(Schema.Record(Schema.String, McpStatus.Status)),
      error: [ServiceUnavailableError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.mcp.status",
          summary: "Live MCP connection status",
          description:
            "Per-server live connection status. Unavailable (503) in an assembly with no live MCP runtime.",
        }),
      ),
  )
  .annotateMerge(OpenApi.annotations({ title: "mcp", description: "MCP server catalog routes." }))
