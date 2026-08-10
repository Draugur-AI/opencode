export * as ProjectPreference from "./preference"

import { and, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { ProjectPreference as PreferenceSchema } from "@opencode-ai/schema/project-preference"
import { NonNegativeInt } from "@opencode-ai/schema/schema"
import type { Database } from "../database/database"
import { ProjectSchema } from "./schema"
import { ProjectPreferenceTable, ProjectTable } from "./sql"

type DatabaseService = Database.Interface["db"]

export const Value = PreferenceSchema.Value
export type Value = PreferenceSchema.Value
export const Patch = PreferenceSchema.Patch
export type Patch = PreferenceSchema.Patch
export const Event = PreferenceSchema.Event

/** A patch lost to a concurrent one, or carried a stale `expectedRevision`. Carries the revision
 * the row actually holds so a client can retry without a second read. */
export class Conflict extends Schema.TaggedErrorClass<Conflict>()("ProjectPreference.Conflict", {
  projectID: ProjectSchema.ID,
  revision: NonNegativeInt,
}) {}

/** The referenced project does not exist. Checked explicitly, rather than left to the
 * project_preference FK constraint: an unhandled constraint violation on the create path (no
 * prior row, so nothing for the revision check to catch) surfaced as a 500 instead of a 404 --
 * caught by the httpapi exerciser's automatic per-route bad-ID probe. */
export class ProjectNotFound extends Schema.TaggedErrorClass<ProjectNotFound>()("ProjectPreference.ProjectNotFound", {
  projectID: ProjectSchema.ID,
}) {}

const defaults = (projectID: ProjectSchema.ID): Value => ({
  projectID,
  favorite: false,
  hidden: false,
  rank: undefined,
  lastOpenedAt: undefined,
  revision: 0,
})

const fromRow = (row: typeof ProjectPreferenceTable.$inferSelect): Value => ({
  projectID: row.project_id,
  favorite: row.favorite,
  rank: row.rank ?? undefined,
  hidden: row.hidden,
  lastOpenedAt: row.time_last_opened ?? undefined,
  revision: row.revision,
})

/** A project with no preference row yet reads as the untouched default — the migration does not
 * backfill one, and neither does a plain read. Only a write ever creates the row. */
export const get = Effect.fn("ProjectPreference.get")(function* (db: DatabaseService, projectID: ProjectSchema.ID) {
  const row = yield* db
    .select()
    .from(ProjectPreferenceTable)
    .where(eq(ProjectPreferenceTable.project_id, projectID))
    .get()
    .pipe(Effect.orDie)
  return row ? fromRow(row) : defaults(projectID)
})

/**
 * Compare-and-set upsert. `expectedRevision` absent or `0` means "I believe no preference row
 * exists yet": insert, and conflict if one already does. Otherwise: update in place, and conflict
 * if the row's revision has moved past what the caller last saw.
 */
export const patch = Effect.fn("ProjectPreference.patch")(function* (
  db: DatabaseService,
  input: {
    readonly projectID: ProjectSchema.ID
    readonly patch: Patch
    readonly expectedRevision?: number
    readonly now: number
  },
) {
  const project = yield* db
    .select({ id: ProjectTable.id })
    .from(ProjectTable)
    .where(eq(ProjectTable.id, input.projectID))
    .get()
    .pipe(Effect.orDie)
  if (!project) return yield* new ProjectNotFound({ projectID: input.projectID })

  const set = {
    favorite: input.patch.favorite,
    rank: input.patch.rank,
    hidden: input.patch.hidden,
    time_last_opened: input.patch.lastOpenedAt,
    time_updated: input.now,
  }

  if (!input.expectedRevision) {
    const created = yield* db
      .insert(ProjectPreferenceTable)
      .values({
        project_id: input.projectID,
        favorite: input.patch.favorite ?? false,
        rank: input.patch.rank,
        hidden: input.patch.hidden ?? false,
        time_last_opened: input.patch.lastOpenedAt,
        revision: 1,
        time_created: input.now,
        time_updated: input.now,
      })
      .onConflictDoNothing()
      .returning()
      .get()
      .pipe(Effect.orDie)
    if (created) return fromRow(created)
    const current = yield* get(db, input.projectID)
    return yield* new Conflict({ projectID: input.projectID, revision: current.revision })
  }

  const updated = yield* db
    .update(ProjectPreferenceTable)
    .set({ ...set, revision: input.expectedRevision + 1 })
    .where(
      and(
        eq(ProjectPreferenceTable.project_id, input.projectID),
        eq(ProjectPreferenceTable.revision, input.expectedRevision),
      ),
    )
    .returning()
    .get()
    .pipe(Effect.orDie)
  if (updated) return fromRow(updated)
  const current = yield* get(db, input.projectID)
  return yield* new Conflict({ projectID: input.projectID, revision: current.revision })
})
