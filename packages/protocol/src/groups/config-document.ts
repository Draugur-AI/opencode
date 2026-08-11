import { ConfigDocument } from "@opencode-ai/schema/config-document"
import { Location } from "@opencode-ai/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ConfigDocumentConflictError, ConfigDocumentTargetNotFoundError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const ConfigDocumentGroup = HttpApiGroup.make("server.config-document")
  .add(
    HttpApiEndpoint.get("config.document.target.list", "/api/config/document/target", {
      query: LocationQuery,
      success: Location.response(Schema.Array(ConfigDocument.TargetSummary)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.config.document.target.list",
          summary: "List config document targets",
          description: "Global and project documents this location can edit, lowest to highest precedence.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("config.document.target.read", "/api/config/document/target/:targetID", {
      params: { targetID: ConfigDocument.TargetID },
      query: LocationQuery,
      success: Location.response(ConfigDocument.ReadResult),
      error: ConfigDocumentTargetNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.config.document.target.read",
          summary: "Read a config document target",
          description: "Raw text, parsed value, hash, and diagnostics for one target.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("config.document.effective.get", "/api/config/document/effective", {
      query: LocationQuery,
      success: Location.response(ConfigDocument.EffectiveResult),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.config.document.effective.get",
          summary: "Get effective config with provenance",
          description: "Merged config values with the source target that set each field, computed fresh from disk.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("config.document.target.validate", "/api/config/document/target/:targetID/validate", {
      params: { targetID: ConfigDocument.TargetID },
      query: LocationQuery,
      payload: Schema.Struct({ patch: ConfigDocument.Patch }),
      success: Location.response(ConfigDocument.ValidateResult),
      error: ConfigDocumentTargetNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.config.document.target.validate",
          summary: "Validate a config document patch",
          description: "Preview diagnostics and the effective result of a patch without writing it.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("config.document.target.apply", "/api/config/document/target/:targetID/apply", {
      params: { targetID: ConfigDocument.TargetID },
      query: LocationQuery,
      payload: Schema.Struct({ expectedHash: Schema.String, patch: ConfigDocument.Patch }),
      success: Location.response(ConfigDocument.ApplyResult),
      error: [ConfigDocumentTargetNotFoundError, ConfigDocumentConflictError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.config.document.target.apply",
          summary: "Apply a config document patch",
          description:
            "Atomic patch against the target's own text, gated on an optimistic hash check. Never serializes the merged config back to a file.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "config-document",
      description: "Edit a source config document directly -- never the merged result.",
    }),
  )
