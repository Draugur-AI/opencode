import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/sql"
import type { SessionSchema } from "../session/schema"
import type { Monitor } from "@opencode-ai/schema/monitor"
import type { SessionProfile } from "@opencode-ai/schema/session-profile"

// Declaration + current status only, matching Monitor.Info (packages/schema/src/monitor.ts).
// Bounded per-check records (`monitor_check`) and live process ownership (MonitorRuntime) are
// execution-phase and do not exist yet -- TKT-322 PR1 is declaration + recovery only.
export const MonitorTable = sqliteTable(
  "monitor",
  {
    id: text().$type<Monitor.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    title: text().notNull(),
    source: text({ mode: "json" }).notNull().$type<Monitor.Source>(),
    interval_ms: integer().notNull(),
    timeout_ms: integer().notNull(),
    condition: text({ mode: "json" }).notNull().$type<Monitor.Condition>(),
    status: text().$type<Monitor.Status>().notNull().default("starting"),
    attempt: integer().notNull().default(0),
    max_attempts: integer(),
    output_policy: text({ mode: "json" }).notNull().$type<Monitor.OutputPolicy>(),
    profile_snapshot_id: text().$type<SessionProfile.SnapshotID>(),
    time_created: integer().notNull(),
    time_started: integer(),
    time_checked: integer(),
    time_finished: integer(),
    revision: integer().notNull().default(0),
  },
  (table) => [
    index("monitor_session_idx").on(table.session_id),
    // Restart recovery scans "which monitors were live" (diary 2435 §1) with no session_id
    // predicate at all (Monitor.recover() is process-global) -- a composite leading with
    // session_id cannot serve that query (leftmost-column rule), so this leads with status.
    index("monitor_status_idx").on(table.status),
  ],
)
