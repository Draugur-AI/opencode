/**
 * Where the app talks to the current-generation client for the MCP TAB: the catalog (static
 * config), its LIVE CONNECTION STATUS, and the config-document read/validate/apply calls that
 * back editing a server through that same tab. Nothing beyond what the MCP tab itself needs.
 *
 * `@opencode-ai/client` (used everywhere else in this app) is a vendored snapshot generated before
 * this domain existed in its current shape — it does carry an `mcp.list`, but at a stale, nested
 * `McpServer` type (includes a `pending` status this domain's union does not have) rather than
 * `McpCatalog.Entry`'s flat `status: "configured" | "disabled"`, and it has no `mcp.status` or
 * config-document target read/validate/apply at all. `@opencode-ai/sdk` (v2, what
 * `useServerSDK()` gives the rest of the app) only has the OLD legacy MCP surface (`/mcp`,
 * `/mcp/{name}/connect`, etc.) — no `/api/mcp`, `/api/mcp/status`, or `/api/config/document/*`.
 * `@opencode-ai/client-next` aliases the workspace client, regenerated from the live protocol, and
 * is the only one of the three with all of this at the current shape.
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
 * surface (see above), so this page exists via client-next or not at all. Widened the SAME day
 * (still chunk 3) to add the three config-document verbs FOR THE MCP TAB specifically -- widening
 * an importer that already serves this exact feature adds zero to the bound (still four files),
 * where a fifth file for the identical purpose would not. Skills/plugins/profiles editing is NOT
 * this file's job: when a second real consumer of config-document read/validate/apply exists,
 * THAT is the moment to decide widen-this-file vs. new-file, not before -- speculative generality
 * for editors that do not exist yet is exactly the flexibility-nobody-requested this app avoids by
 * convention. If you are adding a FIFTH importer for something the MCP tab does not need, that is
 * a stronger signal still to finish TKT-328 instead.
 *
 * Six calls: mcp.list (the static catalog), mcp.status (live connection status, per server name,
 * 503 when no live McpRuntime exists in this assembly -- see `isServiceUnavailableError`), and
 * config-document's targetList/targetRead/targetValidate/targetApply (the typed Patch mechanism
 * editing goes through -- see `document.ts`'s own doc comment for why a client editing through
 * this never round-trips a real secret value: editing a secret field always WRITES a new value,
 * never reads the old one back to prefill it; every read response is redacted, with no operation
 * to reveal one). `targetList` specifically resolves a target for a brand-new server that has no
 * existing catalog entry to read a target off of. Input/output shapes are the generated client's
 * own wire types, never hand-written here.
 */

import { OpenCode, isServiceUnavailableError } from "@opencode-ai/client-next"
import type {
  McpListInput,
  McpListOutput,
  McpStatusInput,
  McpStatusOutput,
  ConfigDocumentTargetListInput,
  ConfigDocumentTargetListOutput,
  ConfigDocumentTargetReadInput,
  ConfigDocumentTargetReadOutput,
  ConfigDocumentTargetValidateInput,
  ConfigDocumentTargetValidateOutput,
  ConfigDocumentTargetApplyInput,
  ConfigDocumentTargetApplyOutput,
} from "@opencode-ai/client-next"
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

export const createMcpClient = (conn: ServerConnection.Any) => {
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
    configDocument: {
      /** The available targets (global + project) -- used to resolve which target a brand-new
       * MCP server (no existing catalog entry to read a target off of) should be written to. */
      targetList: (input?: ConfigDocumentTargetListInput): Promise<ConfigDocumentTargetListOutput> =>
        client.configDocument.targetList(input),
      /** Raw text (redacted) + parsed value + hash for optimistic concurrency. The hash returned
       * here must be echoed back to `targetApply` unchanged -- it is over the REAL on-disk text,
       * not the redacted display copy. */
      targetRead: (input: ConfigDocumentTargetReadInput): Promise<ConfigDocumentTargetReadOutput> =>
        client.configDocument.targetRead(input),
      /** Diagnostics + a merged preview, without writing anything. */
      targetValidate: (input: ConfigDocumentTargetValidateInput): Promise<ConfigDocumentTargetValidateOutput> =>
        client.configDocument.targetValidate(input),
      /** Rejects with ConfigDocumentConflictError (409, stale expectedHash) or InvalidRequestError
       * (400, the patch would write the redaction sentinel over a secret field). */
      targetApply: (input: ConfigDocumentTargetApplyInput): Promise<ConfigDocumentTargetApplyOutput> =>
        client.configDocument.targetApply(input),
    },
  }
}

export type McpClient = ReturnType<typeof createMcpClient>
// Derived from the client's OWN return shape rather than re-exporting the client-next wire types
// directly -- callers get the types they need without importing `@opencode-ai/client-next` a
// second time, keeping the alias's surface bounded to this one file (Copilot review, PR #36).
export type McpListResult = Awaited<ReturnType<McpClient["mcp"]["list"]>>
export type McpStatusResult = Awaited<ReturnType<McpClient["mcp"]["status"]>>
export type McpConfigTargetListResult = Awaited<ReturnType<McpClient["configDocument"]["targetList"]>>
export type McpConfigTargetReadResult = Awaited<ReturnType<McpClient["configDocument"]["targetRead"]>>
export type McpConfigTargetValidateResult = Awaited<ReturnType<McpClient["configDocument"]["targetValidate"]>>
export type McpConfigTargetApplyResult = Awaited<ReturnType<McpClient["configDocument"]["targetApply"]>>
export { isServiceUnavailableError }
