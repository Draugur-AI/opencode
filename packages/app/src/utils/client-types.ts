/**
 * Named types for the current-generation client, derived from what it actually generates.
 *
 * ## Why this file exists
 *
 * The vendored `@opencode-ai/client` snapshot exported standalone entity types (`SessionInfo`,
 * `FileDiffInfo`, …) and grouped API objects (`SessionApi`, `CatalogApi`, …). The current
 * generator emits neither: it emits one operation-scoped type per route (`SessionsListOutput`,
 * `FilesFindOutput`) and puts the groups on the client instance rather than in the type export.
 *
 * Both shapes are recoverable by indexed access. This file does that ONCE, under the names the
 * app already reads, so a reviewer sees `SessionInfo` at a call site instead of
 * `SessionsListOutput["data"][number]` forty-six times over.
 *
 * ## The derivation rule
 *
 * Every alias here derives from a REAL generated identifier — never from a remembered one. A
 * guessed generated name typechecks nowhere and rots silently everywhere, which is not a
 * hypothetical: the first draft of this migration reached for `FilesDiffOutput`, which does not
 * exist. If you add an alias, name the operation it comes from and let the typecheck prove it.
 *
 * ## Retirement
 *
 * 🛑 TEMPORARY. This file deletes when upstream's generator emits entity and group types under
 * stable names, or when phase 2 of TKT-328 unifies the app's session-type surface — whichever
 * lands first. It is a leaf: nothing upstream imports it, so it conflicts with nothing on sync,
 * which is precisely why it lives here rather than as fork-only emission rules inside the shared
 * `httpapi-codegen` generator. Fork-only rules in a shared generator re-conflict on every sync,
 * forever; a leaf module conflicts on none and deletes in one commit. See FORK.md's ledger.
 */

import type { OpenCode } from "@opencode-ai/client"
import type { CommandsListOutput, FilesFindOutput, IntegrationsConnectOauthOutput, IntegrationsListOutput, ServerProjectGetOutput, SessionsActiveOutput, SessionsGetOutput, SessionsListInput, SessionsListOutput, SessionsMessageOutput, SessionsPromptOutput } from "@/utils/client-types"
/** The client instance every group hangs off. */
export type OpenCodeClient = ReturnType<typeof OpenCode.make>

// ---- grouped API objects -------------------------------------------------------------------
// The capability was never missing — only the exported alias. These are the groups the client
// already carries, named so a signature can say what it takes.

export type SessionApi = OpenCodeClient["sessions"]
export type CatalogApi = OpenCodeClient["models"]
export type AgentApi = OpenCodeClient["agents"]
export type CommandApi = OpenCodeClient["commands"]
export type ReferenceApi = OpenCodeClient["references"]

// ---- entity types --------------------------------------------------------------------------
// Each names the operation it is recovered from, so the next reader can check the derivation
// against the generator rather than trusting this comment.

/** One session, as `sessions.get` returns it. */
export type SessionInfo = SessionsGetOutput["data"]
/** The list element — same entity, reached through `sessions.list`. */
export type SessionListItem = SessionsListOutput["data"][number]
export type SessionListInput = SessionsListInput
/** One projected message, from `sessions.message`. */
export type SessionMessageInfo = SessionsMessageOutput["data"]
/** What `sessions.prompt` hands back for an admitted-but-unsent input. */
export type SessionPendingMessage = SessionsPromptOutput["data"]
/** One command, from `commands.list`. */
export type CommandInfo = CommandsListOutput["data"][number]
/** One integration's auth method, from `integrations.list`. */
export type IntegrationMethod = IntegrationsListOutput["data"][number]
/** One file diff, from `files.find`. */
export type FileDiffInfo = FilesFindOutput["data"][number]
/** Which sessions this process is currently running, from `sessions.active`. */
export type SessionActiveOutput = SessionsActiveOutput
/**
 * A project as the current server reports it. The generator prefixes this group `ServerProject`
 * rather than `Projects` — the one place the pluralisation pattern does not hold, which is why
 * this alias exists rather than a guessed `ProjectsGetOutput`.
 */
export type CurrentProject = ServerProjectGetOutput["data"]
/** The oauth authorization payload, from `integrations.connectOauth`. */
export type IntegrationOauthConnectOutput = IntegrationsConnectOauthOutput
