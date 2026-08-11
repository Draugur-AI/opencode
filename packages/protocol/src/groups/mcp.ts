import { McpCatalog } from "@opencode-ai/schema/mcp-catalog"
import { Location } from "@opencode-ai/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
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
  .annotateMerge(OpenApi.annotations({ title: "mcp", description: "MCP server catalog routes." }))
