import { McpCatalog } from "@opencode-ai/core/config/mcp-catalog"
import { McpRuntime } from "@opencode-ai/core/config/mcp-runtime"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ServiceUnavailableError } from "@opencode-ai/protocol/errors"
import { Api } from "../api"
import { response } from "../location"

export const McpHandler = HttpApiBuilder.group(Api, "server.mcp", (handlers) =>
  handlers
    .handle(
      "mcp.list",
      Effect.fn(function* () {
        const catalog = yield* McpCatalog.Service
        return yield* response(catalog.list())
      }),
    )
    .handle(
      "mcp.status",
      Effect.fn(function* () {
        // McpRuntime.node is a BOUND node (never unbound in a shared group -- see the port's own
        // doc), so this is always present: either the real assembly's live projection, or the
        // port's own default, which always fails UnavailableError. Map that typed failure to the
        // wire-level ServiceUnavailableError here; a truthful 503, never a fabricated status.
        const runtime = yield* McpRuntime.Service
        return yield* response(runtime.status()).pipe(
          Effect.catchTag("McpRuntime.UnavailableError", () =>
            Effect.fail(
              new ServiceUnavailableError({
                message: "No live MCP runtime in this assembly",
                service: "mcp.status",
              }),
            ),
          ),
        )
      }),
    ),
)
