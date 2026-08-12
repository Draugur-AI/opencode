/**
 * The ONLY place the app talks to the current-generation client for project data.
 *
 * `@opencode-ai/client` (used everywhere else in this app) is a vendored snapshot generated
 * before session lifecycle existed — it has no project.get, updateMetadata, or preference
 * read/write, because those routes did not exist when it was packed (it only ever had
 * list/current). `@opencode-ai/client-next` aliases the workspace client, regenerated from the
 * live protocol.
 *
 * 🛑 This file is deliberately the whole surface of this alias's project half. Nothing else may
 * import `@opencode-ai/client-next` for project calls: four client generations in one app is a
 * wart we are carrying on purpose and for a bounded time, not a pattern to spread.
 * `packages/app/src/utils/session-lifecycle-client.ts` is the sibling file for the session-
 * lifecycle half (restore/trash/restoreFromTrash/purge), `goal-ledger-client.ts` (TKT-335) is
 * the sibling for the session goal and working ledger half, and `mcp-client.ts` (TKT-323
 * chunk 3) is the sibling for the MCP catalog + live status half — these four files are the only
 * importers, by ruling (TKT-315, then the lead's TKT-328 re-scope 2026-08-11, then the Integrations
 * page 2026-08-12, all cross-referenced in FORK.md's divergence ledger). TKT-328 migrates every
 * call site onto one client and deletes all four files along with the vendored tarball.
 *
 * Five calls, nothing else: list, get, updateMetadata, preference read, preference write.
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

export interface ProjectPreferenceWrite {
  readonly projectID: string
  readonly favorite?: boolean
  readonly rank?: string
  readonly hidden?: boolean
  readonly lastOpenedAt?: number
  /**
   * The revision the caller believed it was acting on. The server rejects a stale one with 409
   * rather than letting a client overwrite a change it never saw.
   */
  readonly expectedRevision?: number
}

export const createProjectClient = (http: ServerConnection.HttpBase) => {
  const client = OpenCode.make({ baseUrl: http.url, fetch: authorizedFetch(http) })
  const project = client["server.project"]
  return {
    list: () => project.list(),
    get: (input: { readonly projectID: string }) => project.get(input),
    updateMetadata: (input: {
      readonly projectID: string
      readonly name?: string
      readonly icon?: { readonly url?: string; readonly override?: string; readonly color?: string }
      readonly commands?: { readonly start?: string }
    }) => project.updateMetadata(input),
    preferenceRead: (input: { readonly projectID: string }) => project.read(input),
    preferenceWrite: (input: ProjectPreferenceWrite) => project.write(input),
  }
}

export type ProjectClient = ReturnType<typeof createProjectClient>
