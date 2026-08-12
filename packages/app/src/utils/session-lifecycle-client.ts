/**
 * Where the app talks to the current-generation client for SESSION LIFECYCLE, and nothing else.
 *
 * `@opencode-ai/client` (used everywhere else in this app) is a vendored snapshot generated before
 * session lifecycle existed — it has no restore, trash, restoreFromTrash, purge, lifecycle-aware
 * list, or get, because those routes did not exist when it was packed. `@opencode-ai/client-next`
 * aliases the workspace client, which is regenerated from the live protocol.
 *
 * 🛑 This file is one of exactly THREE bounded importers of `@opencode-ai/client-next` — the
 * others are `project-client.ts` (project surface) and `goal-ledger-client.ts` (session goal and
 * working ledger, TKT-335). Each owns its own verbs and none edit the others; nothing else may
 * import the alias at all. Three client generations in one app is a wart we carry on purpose and
 * for a bounded time, not a pattern to spread. TKT-328 migrates every call site onto one client
 * and deletes the alias and all three modules. See FORK.md's ledger.
 *
 * The siblings exist so several agents can work separate surfaces without touching one file. This
 * bound was two importers until the lead's TKT-328 re-scope (2026-08-11) admitted a third; if you
 * are adding a fourth, that is a stronger signal still to finish TKT-328 instead.
 *
 * Archive is NOT here. It still goes through the V1 route the app already uses, which the slice-1
 * server-side adapter now drives into the same lifecycle service — so archive already produces the
 * same durable result without a second client.
 *
 * Six calls, nothing else: four lifecycle mutations (restore, trash, restoreFromTrash, purge) plus
 * list and get (TKT-314) — the lifecycle-aware snapshot feed for the normalized session-entities
 * store needs `lifecycle: "all"`, which the vendored client's list endpoint does not support at
 * all. Widening this file's own verb count instead of opening a third importer keeps the
 * one-file-per-surface discipline intact.
 */

import { OpenCode } from "@opencode-ai/client-next"
import type { SessionsListOutput, SessionsGetOutput } from "@opencode-ai/client-next"
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

/**
 * A caller-supplied idempotency key. The server deduplicates on it, so a retry after a dropped
 * response resolves to the first outcome instead of archiving, restoring and archiving again.
 * Generated per user intent, not per attempt — a retry of the SAME intent must reuse the key.
 */
export const lifecycleRequestID = () => crypto.randomUUID()

export interface LifecycleMutation {
  readonly sessionID: string
  readonly requestID: string
  /**
   * The revision the caller believed it was acting on. The server rejects a stale one with 409
   * rather than letting a client undo a change it never saw.
   */
  readonly expectedLifecycleRevision?: number
}

export const createSessionLifecycleClient = (conn: ServerConnection.Any) => {
  const client = OpenCode.make({ baseUrl: conn.http.url, fetch: authorizedFetch(conn.http) })
  return {
    /** Archived -> active. */
    restore: (input: LifecycleMutation) => client.sessions.restore(input),
    /** Active or archived -> trash, recoverable until its purge deadline. */
    trash: (input: LifecycleMutation) => client.sessions.trash(input),
    /** Trash -> back to whichever state it came from. */
    restoreFromTrash: (input: LifecycleMutation) => client.sessions.restoreFromTrash(input),
    /**
     * Permanent. `confirmation` must echo the session ID — the server refuses otherwise, so
     * deletion cannot be reached by a stray boolean.
     */
    purge: (input: { readonly sessionID: string; readonly requestID: string }) =>
      client.sessions.purge({ ...input, confirmation: input.sessionID }),
    /**
     * Index-summary shape (id/lifecycle/title/tokens/time — no messages), same fields
     * `home-session-index.ts` fetches for its own list, just lifecycle-aware. Used for the
     * session-entities feed's snapshot, never for a full transcript.
     */
    list: (input: {
      readonly lifecycle?: "active" | "archived" | "trash" | "all"
      readonly limit?: number
      readonly order?: "asc" | "desc"
      readonly cursor?: string
      // Explicit return type: tsgo does not reliably carry the `{data, cursor}` wrapper through
      // this generated client's generic `request<T>()` chain without help.
    }): Promise<SessionsListOutput> => client.sessions.list(input),
    /** One session's current lifecycle, for the `session.next.lifecycle.changed` re-fetch path
     * — that event carries `from`/`to` but no revision and no full session, so this is what
     * turns it into a dispatchable snapshot instead of a guess. Same explicit-return-type note
     * as `list` above. */
    get: (input: { readonly sessionID: string }): Promise<SessionsGetOutput> => client.sessions.get(input),
  }
}

export type SessionLifecycleClient = ReturnType<typeof createSessionLifecycleClient>
