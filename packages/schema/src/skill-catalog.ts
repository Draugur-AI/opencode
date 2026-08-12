export * as SkillCatalog from "./skill-catalog"

import { Schema } from "effect"
import { ConfigDocument } from "./config-document"
import { NonNegativeInt } from "./schema"
import { Skill } from "./skill"

export class Entry extends Schema.Class<Entry>("Skill.Catalog.Entry")({
  skill: Skill.Info,
  source: Skill.Source,
  /** Index into this location's registered source list, in registration order -- the same
   * ordering `mergeSkills` (packages/core/src/skill.ts) resolves collisions against. Exposed so a
   * client can show "this one, not that one" without re-deriving the winner itself. */
  sourceIndex: NonNegativeInt,
  /** Present only when a later-registered source declares a skill of the same name -- absent
   * means this is the effective (winning) skill `SkillV2.list()` would also return. */
  shadowedBy: Schema.Struct({ source: Skill.Source, sourceIndex: NonNegativeInt }).pipe(Schema.optional),
  /** The config-document target that encloses this skill's declaring location, so a client can
   * jump straight to editing it -- present for a `directory` source whose path falls under a
   * known target's directory (global or a discovered project tier), walking up to the nearest
   * enclosing one when the exact directory has no config file of its own (e.g. a bare `.opencode`
   * tier). Absent for `url` and `embedded` sources, which have no location to attribute at all. */
  target: ConfigDocument.TargetID.pipe(Schema.optional),
}) {}
