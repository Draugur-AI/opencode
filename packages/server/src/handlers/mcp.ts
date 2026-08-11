import { McpCatalog } from "@opencode-ai/core/config/mcp-catalog"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const McpHandler = HttpApiBuilder.group(Api, "server.mcp", (handlers) =>
  handlers.handle(
    "mcp.list",
    Effect.fn(function* () {
      const catalog = yield* McpCatalog.Service
      return yield* response(catalog.list())
    }),
  ),
)
