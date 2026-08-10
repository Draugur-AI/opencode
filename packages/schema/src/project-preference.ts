export * as ProjectPreference from "./project-preference"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { NonNegativeInt, optional } from "./schema"
import { ProjectID } from "./project-id"

/**
 * Per-user organization of a project: favorite, custom order, whether it is hidden from the
 * default views. Deliberately keyed by `projectID` alone for now — OpenCode has no durable user
 * principal yet, so a personal local server has exactly one preference row per project. See the
 * build post ("Projects: finish the V2 move before adding favorites"): migrate to
 * `(principal_id, project_id)` once a real ownership model exists, rather than encoding
 * browser-local storage as identity today.
 */
export const Value = Schema.Struct({
  projectID: ProjectID,
  favorite: Schema.Boolean,
  rank: optional(Schema.String),
  hidden: Schema.Boolean,
  lastOpenedAt: optional(NonNegativeInt),
  revision: NonNegativeInt,
}).annotate({ identifier: "ProjectPreference" })
export interface Value extends Schema.Schema.Type<typeof Value> {}

/** What a caller may change. Fields absent from a patch are left as they are. */
export const Patch = Schema.Struct({
  favorite: optional(Schema.Boolean),
  rank: optional(Schema.String),
  hidden: optional(Schema.Boolean),
  lastOpenedAt: optional(NonNegativeInt),
}).annotate({ identifier: "ProjectPreferencePatch" })
export interface Patch extends Schema.Schema.Type<typeof Patch> {}

const Updated = define({ type: "project.preference.updated", schema: Value.fields })
export const Event = { Updated, Definitions: inventory(Updated) }
