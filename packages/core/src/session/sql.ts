import { sqliteTable, text, integer, index, primaryKey, real, uniqueIndex } from "drizzle-orm/sqlite-core"
import * as DatabasePath from "../database/path"
import { ProjectTable } from "../project/sql"
import type { SessionMessage } from "./message"
import type { Prompt } from "./prompt"
import type { SessionInput } from "./input"
import type { Snapshot } from "../snapshot"
import { PermissionV1 } from "../v1/permission"
import { ProjectV2 } from "../project"
import type { SessionSchema } from "./schema"
import type { MessageID, PartID, SessionV1 } from "../v1/session"
import { WorkspaceV2 } from "../workspace"
import { Timestamps } from "../database/schema.sql"
import type { SystemContext } from "../system-context/index"
import { AgentV2 } from "../agent"
import type { Revert } from "@opencode-ai/schema/revert"
import type { SessionLifecycle } from "@opencode-ai/schema/session-lifecycle"
import type { SessionGoal } from "@opencode-ai/schema/session-goal"
import type { SessionLedger } from "@opencode-ai/schema/session-ledger"
import type { SessionProfile } from "@opencode-ai/schema/session-profile"

type SessionMessageData = Omit<(typeof SessionMessage.Message)["Encoded"], "type" | "id">
type V1MessageData = Omit<SessionV1.Info, "id" | "sessionID">
type V1PartData = Omit<SessionV1.Part, "id" | "sessionID" | "messageID">

export const SessionTable = sqliteTable(
  "session",
  {
    id: text().$type<SessionSchema.ID>().primaryKey(),
    project_id: text()
      .$type<ProjectV2.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    workspace_id: text().$type<WorkspaceV2.ID>(),
    parent_id: text().$type<SessionSchema.ID>(),
    slug: text().notNull(),
    directory: DatabasePath.directoryColumn().notNull(),
    path: DatabasePath.pathColumn(),
    title: text().notNull(),
    version: text().notNull(),
    share_url: text(),
    summary_additions: integer(),
    summary_deletions: integer(),
    summary_files: integer(),
    summary_diffs: text({ mode: "json" }).$type<Snapshot.LegacyFileDiff[]>(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
    cost: real().notNull().default(0),
    tokens_input: integer().notNull().default(0),
    tokens_output: integer().notNull().default(0),
    tokens_reasoning: integer().notNull().default(0),
    tokens_cache_read: integer().notNull().default(0),
    tokens_cache_write: integer().notNull().default(0),
    revert: text({ mode: "json" }).$type<Revert.State>(),
    permission: text({ mode: "json" }).$type<PermissionV1.Ruleset>(),
    agent: text(),
    model: text({ mode: "json" }).$type<{
      id: string
      providerID: string
      variant?: string
    }>(),
    ...Timestamps,
    time_compacting: integer(),
    /** @deprecated Read `lifecycle` instead. Retained for the V1 compatibility window. */
    time_archived: integer(),
    lifecycle: text().$type<SessionLifecycle.State>().notNull().default("active"),
    lifecycle_revision: integer().notNull().default(0),
    time_trashed: integer(),
    purge_after: integer(),
    /**
     * Where `restoreFromTrash` returns this session. Recorded when it enters trash, because
     * restoring an archived session to `active` would silently undo the archive the user chose.
     */
    trash_restore_to: text().$type<Exclude<SessionLifecycle.State, "trash">>(),
    /** The session's CURRENT resolved profile snapshot. Null means no profile has been resolved
     * yet (pre-migration sessions, or a session created before this ticket's resolve-on-create
     * wiring runs). Past snapshots stay reachable through SessionEvent.ProfileSwitched even after
     * this column moves on to a newer one. */
    profile_snapshot_id: text().$type<SessionProfile.SnapshotID>(),
  },
  (table) => [
    index("session_project_idx").on(table.project_id),
    index("session_workspace_idx").on(table.workspace_id),
    index("session_parent_idx").on(table.parent_id),
    index("session_project_lifecycle_updated_id_idx").on(
      table.project_id,
      table.lifecycle,
      table.time_updated,
      table.id,
    ),
  ],
)

/**
 * What survives a purge. Lets a client tell "permanently deleted" from "not fetched yet" for a
 * bounded retention period. It holds no transcript content, by design and by test.
 */
export const SessionTombstoneTable = sqliteTable(
  "session_tombstone",
  {
    id: text().$type<SessionSchema.ID>().primaryKey(),
    project_id: text()
      .$type<ProjectV2.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    time_purged: integer().notNull(),
    last_lifecycle_revision: integer().notNull(),
  },
  (table) => [index("session_tombstone_time_purged_idx").on(table.time_purged)],
)

/**
 * Bounded record of lifecycle mutations already applied, keyed by the caller's request ID. A
 * mobile retry after a dropped response resolves to the recorded outcome instead of archiving,
 * restoring, and archiving again.
 */
export const SessionLifecycleRequestTable = sqliteTable(
  "session_lifecycle_request",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    request_id: text().$type<SessionLifecycle.RequestID>().notNull(),
    lifecycle_revision: integer().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.request_id] }),
    index("session_lifecycle_request_session_time_idx").on(table.session_id, table.time_created),
  ],
)

export const MessageTable = sqliteTable(
  "message",
  {
    id: text().$type<MessageID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<V1MessageData>(),
  },
  (table) => [index("message_session_time_created_id_idx").on(table.session_id, table.time_created, table.id)],
)

export const PartTable = sqliteTable(
  "part",
  {
    id: text().$type<PartID>().primaryKey(),
    message_id: text()
      .$type<MessageID>()
      .notNull()
      .references(() => MessageTable.id, { onDelete: "cascade" }),
    session_id: text().$type<SessionSchema.ID>().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<V1PartData>(),
  },
  (table) => [
    index("part_message_id_id_idx").on(table.message_id, table.id),
    index("part_session_idx").on(table.session_id),
  ],
)

export const TodoTable = sqliteTable(
  "todo",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    content: text().notNull(),
    status: text().notNull(),
    priority: text().notNull(),
    position: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.position] }),
    index("todo_session_idx").on(table.session_id),
  ],
)

export const SessionMessageTable = sqliteTable(
  "session_message",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    type: text().$type<SessionMessage.Type>().notNull(),
    seq: integer().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<SessionMessageData>(),
  },
  (table) => [
    uniqueIndex("session_message_session_seq_idx").on(table.session_id, table.seq),
    index("session_message_session_type_seq_idx").on(table.session_id, table.type, table.seq),
    index("session_message_session_time_created_id_idx").on(table.session_id, table.time_created, table.id),
    index("session_message_time_created_idx").on(table.time_created),
  ],
)

export const SessionInputTable = sqliteTable(
  "session_input",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    prompt: text({ mode: "json" }).notNull().$type<Prompt>(),
    delivery: text().$type<SessionInput.Delivery>().notNull(),
    admitted_seq: integer().notNull(),
    promoted_seq: integer(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    index("session_input_session_pending_delivery_seq_idx").on(
      table.session_id,
      table.promoted_seq,
      table.delivery,
      table.admitted_seq,
    ),
    uniqueIndex("session_input_session_admitted_seq_idx").on(table.session_id, table.admitted_seq),
    uniqueIndex("session_input_session_promoted_seq_idx").on(table.session_id, table.promoted_seq),
  ],
)

export const SessionContextEpochTable = sqliteTable("session_context_epoch", {
  session_id: text()
    .$type<SessionSchema.ID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  baseline: text().notNull(),
  snapshot: text({ mode: "json" }).notNull().$type<SystemContext.Snapshot>(),
  baseline_seq: integer().notNull(),
})

// Atomic replacement, not append-only: the objective and its criteria/constraints are one value
// that changes as a unit, queried only by session (one row per session). Arrays stay typed JSON
// rather than child tables because they're read and written whole, never queried by element.
export const SessionGoalTable = sqliteTable("session_goal", {
  session_id: text()
    .$type<SessionSchema.ID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  objective: text().notNull(),
  acceptance_criteria: text({ mode: "json" }).notNull().$type<SessionGoal.AcceptanceCriterion[]>(),
  constraints: text({ mode: "json" }).notNull().$type<SessionGoal.Constraint[]>(),
  status: text().$type<SessionGoal.Status>().notNull().default("active"),
  source_message_ids: text({ mode: "json" }).notNull().$type<SessionMessage.ID[]>(),
  version: integer().notNull().default(0),
  ...Timestamps,
})

// Append-only: an entry is never edited in place, only superseded (status flips, supersededBy is
// set). Indexed for the context renderer's actual query shape -- active entries for one session,
// newest first.
export const SessionLedgerTable = sqliteTable(
  "session_ledger",
  {
    id: text().$type<SessionLedger.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    kind: text().$type<SessionLedger.Kind>().notNull(),
    text: text().notNull(),
    source_message_ids: text({ mode: "json" }).notNull().$type<SessionMessage.ID[]>(),
    status: text().$type<SessionLedger.EntryStatus>().notNull().default("active"),
    superseded_by: text().$type<SessionLedger.ID>(),
    ...Timestamps,
  },
  (table) => [index("session_ledger_session_status_updated_idx").on(table.session_id, table.status, table.time_updated)],
)

// Immutable: never updated in place, only inserted -- a switch creates a new row and repoints
// session.profile_snapshot_id, it never mutates an old snapshot. That's what keeps a past turn
// explainable against the exact rules it ran under even after the named definition changes.
// Rule maps are stored as opaque JSON (Record<string, "inherit"|"allow"|"deny">); nothing here
// queries into an individual rule, so a child table per rule would just be indirection.
export const SessionProfileSnapshotTable = sqliteTable(
  "session_profile_snapshot",
  {
    id: text().$type<SessionProfile.SnapshotID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    definition_id: text().$type<SessionProfile.ID>().notNull(),
    definition_hash: text().notNull(),
    title: text().notNull(),
    agent: text(),
    tool_rules: text({ mode: "json" }).notNull().$type<SessionProfile.RuleMap>(),
    skill_rules: text({ mode: "json" }).notNull().$type<SessionProfile.RuleMap>(),
    mcp_rules: text({ mode: "json" }).notNull().$type<SessionProfile.RuleMap>(),
    plugin_rules: text({ mode: "json" }).notNull().$type<SessionProfile.RuleMap>(),
    hook_rules: text({ mode: "json" }).notNull().$type<SessionProfile.RuleMap>(),
    monitor_rules: text({ mode: "json" }).notNull().$type<SessionProfile.MonitorRules>(),
    compaction: text(),
    system_append: text(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [index("session_profile_snapshot_session_created_idx").on(table.session_id, table.time_created)],
)
