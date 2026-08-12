/**
 * Where the app talks to the current-generation client for the SESSION GOAL and WORKING LEDGER,
 * and nothing else.
 *
 * `@opencode-ai/client` (used everywhere else in this app) is a vendored snapshot generated before
 * the goal/ledger domain existed — it has no goal get/update/status or ledger list/add/supersede,
 * because those routes did not exist when it was packed. `@opencode-ai/client-next` aliases the
 * workspace client, which is regenerated from the live protocol.
 *
 * 🛑 This file is one of exactly FOUR bounded importers of `@opencode-ai/client-next` — the
 * others are `session-lifecycle-client.ts` (session lifecycle), `project-client.ts` (project
 * data), and `mcp-client.ts` (MCP catalog, live status, and config-document editing for the MCP
 * tab, TKT-323 chunk 3). Each owns its own verbs and none edit the others; nothing else may
 * import the alias at all. Four client
 * generations in one app is a wart we carry on purpose and for a bounded time, not a pattern to
 * spread. TKT-328 migrates every call site onto one client and deletes the alias and all four
 * modules. See FORK.md's ledger.
 *
 * This is the third importer, added by the lead's re-scope of TKT-328 (2026-08-11): the ticket
 * was mechanical-migration-shaped until a real attempt measured 534 semantic type errors, and was
 * re-scoped to a designed migration with an explicit interim state of three bounded importers
 * (session-lifecycle, project, goal-ledger) rather than two. A fourth (`mcp-client.ts`, named
 * `mcp-catalog-client.ts` at first) followed the next day, 2026-08-12, because the Integrations
 * page has no other client that can serve it -- then widened in place (same file, renamed) hours
 * later the same day to also cover config-document editing for the same tab, rather than opening
 * a fifth file for a verb family the MCP tab already needed. If you are adding a FIFTH importer,
 * that is a stronger signal still to finish TKT-328 instead.
 *
 * Six calls, nothing else: goal get/update/status, ledger list/add/supersede. Input/output shapes
 * are the generated client's own wire types (ultimately produced from `@opencode-ai/schema`'s
 * session-goal/session-ledger modules via the protocol layer) — never hand-written here. Note
 * these are the WIRE shapes (e.g. `time.created` as a millis number), not the schema's own decoded
 * domain types (`SessionGoal.Info`, `SessionLedger.Entry`), whose `time` fields decode through
 * `DateTimeUtcFromMillis` into `DateTime.Utc` — a shape this thin JSON client never produces.
 */

import { OpenCode } from "@opencode-ai/client-next"
import type {
  ServerGoalGetInput,
  ServerGoalGetOutput,
  ServerGoalUpdateInput,
  ServerGoalUpdateOutput,
  ServerGoalStatusInput,
  ServerGoalStatusOutput,
  ServerLedgerListInput,
  ServerLedgerListOutput,
  ServerLedgerAddInput,
  ServerLedgerAddOutput,
  ServerLedgerSupersedeInput,
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

export const createGoalLedgerClient = (conn: ServerConnection.Any) => {
  const client = OpenCode.make({ baseUrl: conn.http.url, fetch: authorizedFetch(conn.http) })
  return {
    serverGoal: {
      /** Null when the session has no goal set yet — not an error. */
      get: (input: ServerGoalGetInput): Promise<ServerGoalGetOutput> => client["server.goal"].get(input),
      /**
       * Full replace of objective/acceptanceCriteria/constraints. Only the user rewrites the
       * objective or waives a criterion — the panel enforces that, this call does not. The server
       * rejects a stale `expectedVersion` with 409 rather than letting a client overwrite a change
       * it never saw.
       */
      update: (input: ServerGoalUpdateInput): Promise<ServerGoalUpdateOutput> => client["server.goal"].update(input),
      /** active/achieved/abandoned, same optimistic-concurrency contract as `update`. */
      status: (input: ServerGoalStatusInput): Promise<ServerGoalStatusOutput> => client["server.goal"].status(input),
    },
    serverLedger: {
      /** Defaults to active-only server-side when `status` is omitted. */
      list: (input: ServerLedgerListInput): Promise<ServerLedgerListOutput> => client["server.ledger"].list(input),
      add: (input: ServerLedgerAddInput): Promise<ServerLedgerAddOutput> => client["server.ledger"].add(input),
      /** Marks the entry superseded by a new one; entries are never edited in place. */
      supersede: (input: ServerLedgerSupersedeInput): Promise<void> => client["server.ledger"].supersede(input),
    },
  }
}

export type GoalLedgerClient = ReturnType<typeof createGoalLedgerClient>
