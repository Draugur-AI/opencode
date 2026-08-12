import { Skill } from "@opencode-ai/schema/skill"
import { SkillCatalog } from "@opencode-ai/schema/skill-catalog"
import { Location } from "@opencode-ai/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const SkillGroup = HttpApiGroup.make("server.skill")
  .add(
    HttpApiEndpoint.get("skill.list", "/api/skill", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Skill.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.skill.list",
          summary: "List skills",
          description: "Retrieve currently registered skills.",
        }),
      ),
  )
  .add(
    // TKT-323 SkillCatalog: unlike skill.list (winners only, the runtime-facing view), this
    // reports EVERY entry -- winner and shadowed loser, with provenance and (for a directory
    // source) an enclosing config target -- for a settings surface that needs to show "this one
    // shadows that one," not just the effective result. Both endpoints are backed by the same
    // core-layer merge (SkillV2.Service.entries()/mergeSkills) and cannot disagree about which
    // skill wins a name collision; see SkillCatalog.Service's own doc comment.
    HttpApiEndpoint.get("skill.catalog", "/api/skill/catalog", {
      query: LocationQuery,
      success: Location.response(Schema.Array(SkillCatalog.Entry)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.skill.catalog",
          summary: "List every registered skill, winners and shadowed losers",
          description:
            "Every skill this location knows about, with source provenance, shadowing, and (for directory sources) the enclosing config-document target.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "skills",
      description: "Experimental skill routes.",
    }),
  )
