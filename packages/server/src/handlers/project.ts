import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectPreference } from "@opencode-ai/core/project/preference"
import { EventV2 } from "@opencode-ai/core/event"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { ProjectNotFoundError, ProjectPreferenceConflictError } from "@opencode-ai/protocol/errors"

const notFound = (projectID: ProjectV2.ID) =>
  new ProjectNotFoundError({ projectID, message: `Project not found: ${projectID}` })

export const ProjectHandler = HttpApiBuilder.group(Api, "server.project", (handlers) =>
  Effect.succeed(
    handlers
      .handle("project.list", () =>
        ProjectV2.Service.use((project) => project.list()).pipe(Effect.map((data) => ({ data }))),
      )
      .handle("project.get", (ctx) =>
        ProjectV2.Service.use((project) => project.get(ctx.params.projectID)).pipe(
          Effect.flatMap((data) => (data ? Effect.succeed({ data }) : notFound(ctx.params.projectID))),
        ),
      )
      .handle("project.updateMetadata", (ctx) =>
        Effect.gen(function* () {
          const project = yield* ProjectV2.Service
          const events = yield* EventV2.Service
          const data = yield* project.updateMetadata({ projectID: ctx.params.projectID, ...ctx.payload })
          // Publishing here, not inside core, is deliberate — see the comment on ProjectV2.Info
          // in packages/core/src/project.ts: core cannot depend on EventV2 without a circular
          // import (event.ts -> location.ts -> project.ts).
          yield* events.publish(ProjectV2.Event.Updated, data)
          return { data }
        }).pipe(Effect.catchTag("Project.NotFoundError", (error) => notFound(error.projectID))),
      )
      .handle("project.preference.read", (ctx) =>
        ProjectV2.Service.use((project) => project.preferenceGet(ctx.params.projectID)).pipe(
          Effect.map((data) => ({ data })),
        ),
      )
      .handle("project.preference.write", (ctx) =>
        Effect.gen(function* () {
          const project = yield* ProjectV2.Service
          const events = yield* EventV2.Service
          const data = yield* project.preferencePatch({
            projectID: ctx.params.projectID,
            patch: ctx.payload,
            expectedRevision: ctx.payload.expectedRevision,
          })
          yield* events.publish(ProjectPreference.Event.Updated, data)
          return { data }
        }).pipe(
          Effect.catchTag(
            "ProjectPreference.Conflict",
            (error) =>
              new ProjectPreferenceConflictError({
                projectID: error.projectID,
                revision: error.revision,
                message: `Preference revision conflict for project ${error.projectID}: currently at ${error.revision}`,
              }),
          ),
          Effect.catchTag("ProjectPreference.ProjectNotFound", (error) => notFound(error.projectID)),
        ),
      ),
  ),
)
