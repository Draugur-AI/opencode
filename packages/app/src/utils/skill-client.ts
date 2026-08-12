/**
 * Where the app talks to the current-generation client for the SKILLS TAB: the effective skill
 * list (winners only, the runtime-facing view) and the full catalog (winners AND shadowed losers,
 * with provenance and an enclosing config target) that backs a settings surface showing "this one
 * shadows that one." Nothing beyond what the Skills tab itself needs.
 *
 * `@opencode-ai/client` (used everywhere else in this app) is a vendored snapshot generated before
 * `skill.catalog` existed — it has `skill.list`, but nothing at the catalog shape (shadowing,
 * provenance, target attribution). `@opencode-ai/sdk` v2 (what `useServerSDK()` gives the rest of
 * the app) has no `/api/skill/catalog` at all. `@opencode-ai/client-next` aliases the workspace
 * client, regenerated from the live protocol, and is the only one of the three with this surface.
 *
 * 🛑 This file is one of a small, bounded set of importers of `@opencode-ai/client-next` — the
 * others are `session-lifecycle-client.ts` (session lifecycle), `project-client.ts` (project data),
 * `goal-ledger-client.ts` (session goal + working ledger), and `mcp-client.ts` (MCP catalog, live
 * status, and config-document editing for the MCP tab). Each owns its own verbs and none edit the
 * others; nothing else may import the alias at all. FORK.md's ledger is the single count authority
 * for how many importers exist and why — this header does not restate the number, so the two
 * cannot drift apart (Henry's finding, PR #40 review lineage: six hand-counted copies of a
 * thrice-moved number is indefensible). Client generations in one app is a wart we carry on
 * purpose and for a bounded time, not a pattern to spread. TKT-328 migrates every call site onto
 * one client and deletes the alias and every module the ledger lists.
 *
 * This was the fifth importer, added by ruling for TKT-323 chunk 3's Skills tab (2026-08-12): a
 * genuinely different, unrelated consumer of client-next, not a mis-widen of `mcp-client.ts` to
 * dodge a new file (that file's own header says skills/plugins/profiles are NOT its job). If you
 * are adding a new importer, that is a stronger signal still to finish TKT-328 instead.
 *
 * Calls: skill.list (the effective, winners-only view SkillTool also resolves against) and
 * skill.catalog (every entry, winner and shadowed loser, with provenance and an enclosing
 * config-document target for directory sources -- see `SkillCatalog.Service`'s own doc comment
 * for why this can never disagree with skill.list about which skill wins a name collision: both
 * are backed by the exact same core-layer merge). Input/output shapes are the generated client's
 * own wire types, never hand-written here.
 */

import { OpenCode } from "@opencode-ai/client-next"
import type { SkillsListInput, SkillsListOutput, SkillsCatalogInput, SkillsCatalogOutput } from "@opencode-ai/client-next"
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

export const createSkillClient = (conn: ServerConnection.Any) => {
  const client = OpenCode.make({ baseUrl: conn.http.url, fetch: authorizedFetch(conn.http) })
  return {
    /** The effective (winners-only) skill list -- same fact SkillTool resolves against. */
    list: (input?: SkillsListInput): Promise<SkillsListOutput> => client.skills.list(input),
    /** Every entry -- winner and shadowed loser, with provenance and an enclosing config target. */
    catalog: (input?: SkillsCatalogInput): Promise<SkillsCatalogOutput> => client.skills.catalog(input),
  }
}

export type SkillClient = ReturnType<typeof createSkillClient>
// Derived from the client's OWN return shape rather than re-exporting the client-next wire types
// directly -- callers get the types they need without importing `@opencode-ai/client-next` a
// second time, keeping the alias's surface bounded to this one file (same convention as the other
// importers, established at PR #36).
export type SkillListResult = Awaited<ReturnType<SkillClient["list"]>>
export type SkillCatalogResult = Awaited<ReturnType<SkillClient["catalog"]>>
