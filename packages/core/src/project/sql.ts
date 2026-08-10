import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core"
import * as DatabasePath from "../database/path"
import { Timestamps } from "../database/schema.sql"
import { ProjectSchema } from "./schema"

export const ProjectTable = sqliteTable("project", {
  id: text().$type<ProjectSchema.ID>().primaryKey(),
  worktree: DatabasePath.absoluteColumn().notNull(),
  vcs: text(),
  name: text(),
  icon_url: text(),
  icon_url_override: text(),
  icon_color: text(),
  ...Timestamps,
  time_initialized: integer(),
  sandboxes: DatabasePath.absoluteArrayColumn().notNull(),
  commands: text({ mode: "json" }).$type<{ start?: string }>(),
})

export const ProjectDirectoryTable = sqliteTable(
  "project_directory",
  {
    project_id: text()
      .$type<ProjectSchema.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    directory: DatabasePath.absoluteColumn().notNull(),
    type: text().$type<"main" | "root" | "git_worktree">(),
    strategy: text(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [primaryKey({ columns: [table.project_id, table.directory] })],
)

export const ProjectPreferenceTable = sqliteTable("project_preference", {
  // Keyed by project_id alone, not (principal_id, project_id) — see project-preference.ts.
  project_id: text()
    .$type<ProjectSchema.ID>()
    .primaryKey()
    .references(() => ProjectTable.id, { onDelete: "cascade" }),
  favorite: integer({ mode: "boolean" }).notNull().default(false),
  rank: text(),
  hidden: integer({ mode: "boolean" }).notNull().default(false),
  time_last_opened: integer(),
  // 0 means "no preference change has ever been committed" — the row may not even exist yet.
  // The first successful write produces revision 1, exactly mirroring session lifecycle_revision.
  revision: integer().notNull().default(0),
  ...Timestamps,
})
