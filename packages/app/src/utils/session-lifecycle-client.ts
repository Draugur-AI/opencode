/**
 * Where the app talks to the current-generation client for SESSION LIFECYCLE, and nothing else.
 *
 * `@opencode-ai/client` (used everywhere else in this app) is a vendored snapshot generated before
 * session lifecycle existed — it has no restore, trash, restoreFromTrash or purge, because those
 * routes did not exist when it was packed. `@opencode-ai/client-next` aliases the workspace client,
 * which is regenerated from the live protocol.
 *
 * 🛑 This file is one of exactly TWO bounded importers of `@opencode-ai/client-next` — the other
 * is `project-client.ts`, its sibling for the project surface. Each owns its own verbs and neither
 * edits the other; nothing else may import the alias at all. Two client generations in one app is
 * a wart we carry on purpose and for a bounded time, not a pattern to spread. TKT-328 migrates
 * every call site onto one client and deletes the alias and both modules. See FORK.md's ledger.
 *
 * The sibling exists so two agents can work the two surfaces without touching one file. If you are
 * adding a third importer, that is the signal to finish TKT-328 instead.
 *
 * Archive is NOT here. It still goes through the V1 route the app already uses, which the slice-1
 * server-side adapter now drives into the same lifecycle service — so archive already produces the
 * same durable result without a second client.
 */

import { OpenCode } from "@opencode-ai/client-next"
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

export const createSessionLifecycleClient = (http: ServerConnection.HttpBase) => {
  const client = OpenCode.make({ baseUrl: http.url, fetch: authorizedFetch(http) })
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
  }
}

export type SessionLifecycleClient = ReturnType<typeof createSessionLifecycleClient>
