import { Project } from "@opencode-ai/schema/project"
import { ProjectPreference } from "@opencode-ai/schema/project-preference"
import { Schema, Struct } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ProjectNotFoundError, ProjectPreferenceConflictError } from "../errors"

const UpdateMetadataPayload = Schema.Struct(Struct.pick(Project.Info.fields, ["name", "icon", "commands"])).annotate(
  { identifier: "ProjectUpdateMetadataPayload" },
)

const PreferencePatchPayload = Schema.Struct({
  ...ProjectPreference.Patch.fields,
  expectedRevision: Schema.optional(Schema.Int),
}).annotate({ identifier: "ProjectPreferencePatchPayload" })

export const ProjectGroup = HttpApiGroup.make("server.project")
  .add(
    HttpApiEndpoint.get("project.list", "/api/project", {
      success: Schema.Struct({ data: Schema.Array(Project.Info) }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.project.list",
        summary: "List projects",
        description: "Retrieve every project this server knows about.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("project.get", "/api/project/:projectID", {
      params: { projectID: Project.ID },
      success: Schema.Struct({ data: Project.Info }),
      error: ProjectNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.project.get",
        summary: "Get project",
        description: "Retrieve a project by ID.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.patch("project.updateMetadata", "/api/project/:projectID", {
      params: { projectID: Project.ID },
      payload: UpdateMetadataPayload,
      success: Schema.Struct({ data: Project.Info }),
      error: ProjectNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.project.updateMetadata",
        summary: "Update project metadata",
        description: "Update a project's name, icon, or startup commands.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("project.preference.read", "/api/project/:projectID/preference", {
      params: { projectID: Project.ID },
      success: Schema.Struct({ data: ProjectPreference.Value }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.project.preference.read",
        summary: "Get project preference",
        description:
          "Retrieve favorite/rank/hidden/lastOpened for a project. A project with no preference row yet reads as the untouched default.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.patch("project.preference.write", "/api/project/:projectID/preference", {
      params: { projectID: Project.ID },
      payload: PreferencePatchPayload,
      success: Schema.Struct({ data: ProjectPreference.Value }),
      error: [ProjectPreferenceConflictError, ProjectNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.project.preference.write",
        summary: "Patch project preference",
        description:
          "Compare-and-set update. Omit expectedRevision (or pass 0) only when creating the first preference row for a project; otherwise pass the revision last read, or the request is rejected as a conflict.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "project", description: "First-class project and preference routes." }))
