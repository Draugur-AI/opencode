/**
 * Where the app talks to the current-generation client for the MCP CATALOG (static config) and
 * its LIVE CONNECTION STATUS, and nothing else.
 *
 * `@opencode-ai/client` (used everywhere else in this app) is a vendored snapshot generated before
 * this domain existed in its current shape — it does carry an `mcp.list`, but at a stale, nested
 * `McpServer` type (includes a `pending` status this domain's union does not have) rather than
 * `McpCatalog.Entry`'s flat `status: "configured" | "disabled"`, and it has no `mcp.status` at all.
 * `@opencode-ai/sdk` (v2, what `useServerSDK()` gives the rest of the app) only has the OLD legacy
 * MCP surface (`/mcp`, `/mcp/{name}/connect`, etc.) — no `/api/mcp` or `/api/mcp/status`.
 * `@opencode-ai/client-next` aliases the workspace client, regenerated from the live protocol, and
 * is the only one of the three with both `mcp.list` and `mcp.status` at the current shape.
 *
 * 🛑 This file is one of exactly FOUR bounded importers of `@opencode-ai/client-next` — the others
 * are `session-lifecycle-client.ts` (session lifecycle), `project-client.ts` (project data), and
 * `goal-ledger-client.ts` (session goal + working ledger). Each owns its own verbs and neither
 * edits the others; nothing else may import the alias at all. Four client generations in one app is
 * a wart we carry on purpose and for a bounded time, not a pattern to spread. TKT-328 migrates
 * every call site onto one client and deletes the alias and all four modules. See FORK.md's ledger.
 *
 * This is the fourth importer, added by the lead's re-scope for TKT-323 chunk 3 (2026-08-12): the
 * Integrations page cannot exist without it -- the other two clients are structurally missing the
 * surface (see above), so this page exists via client-next or not at all. If you are adding a
 * FIFTH importer, that is a stronger signal still to finish TKT-328 instead.
 *
 * Two calls, nothing else: mcp.list (the static catalog) and mcp.status (live connection status,
 * per server name, 503 when no live McpRuntime exists in this assembly -- see
 * `isServiceUnavailableError`). Input/output shapes are the generated client's own wire types,
 * never hand-written here.
 */

import { OpenCode, isServiceUnavailableError } from "@opencode-ai/client-next"
import type { McpListInput, McpListOutput, McpStatusInput, McpStatusOutput } from "@opencode-ai/client-next"
import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"

/** Matches how the rest of the app authenticates to a server, rather than inventing a second way. */
const authorizedFetch = (http: ServerConnection.HttpBase): typeof globalThis.fetch => {
  if (!http.password) return globalThis.fetch
  const token = authTokenFromCredentials({ username: http.username, password: http.password })
  const wrapped = (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
    const headers = new Headers(init?.headers)
    headers.set("Authorization", `Basic ${token}`)
    return globalThis.fetch(input, { ...init, headers })
  }
  // `typeof fetch` carries `preconnect` in this runtime. Copy it across rather than casting the
  // type away, so the wrapper stays a drop-in for anything that expects the real fetch.
  return Object.assign(wrapped, { preconnect: globalThis.fetch.preconnect.bind(globalThis.fetch) })
}

export const createMcpCatalogClient = (conn: ServerConnection.Any) => {
  const client = OpenCode.make({ baseUrl: conn.http.url, fetch: authorizedFetch(conn.http) })
  return {
    mcp: {
      /** The static catalog -- configured/disabled only, no liveness. */
      list: (input?: McpListInput): Promise<McpListOutput> => client.mcp.list(input),
      /**
       * Live per-server connection status. Rejects with a ServiceUnavailableError (check with
       * `isServiceUnavailableError`) when this assembly has no live McpRuntime -- callers must
       * render that as a truthful "unavailable" state, never fall back to a fabricated status.
       */
      status: (input?: McpStatusInput): Promise<McpStatusOutput> => client.mcp.status(input),
    },
  }
}

export type McpCatalogClient = ReturnType<typeof createMcpCatalogClient>
export { isServiceUnavailableError }
