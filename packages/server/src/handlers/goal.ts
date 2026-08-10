import { SessionGoal } from "@opencode-ai/core/session/goal"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { SessionGoalConflictError } from "@opencode-ai/protocol/errors"

const conflict = (error: SessionGoal.Conflict) =>
  new SessionGoalConflictError({
    sessionID: error.sessionID,
    version: error.expectedVersion ?? 0,
    message: `Goal changed concurrently; it is now at version ${error.expectedVersion ?? 0}`,
  })

export const GoalHandler = HttpApiBuilder.group(Api, "server.goal", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "session.goal.get",
        Effect.fn(function* (ctx) {
          const goal = yield* SessionGoal.Service
          const value = yield* goal.get(ctx.params.sessionID)
          // A JS object literal `{ data: undefined }` still has the "data" key present (value
          // undefined) -- the schema's Schema.optional accepts that, but the httpapi JSON encoder
          // writes it as `data: null` rather than omitting the key, which fails a strict
          // `=== undefined` check on the wire. Omitting the key entirely, not just its value,
          // is what actually round-trips as absent.
          return value === undefined ? {} : { data: value }
        }),
      )
      .handle(
        "session.goal.update",
        Effect.fn(function* (ctx) {
          const goal = yield* SessionGoal.Service
          return {
            data: yield* goal
              .update({
                sessionID: ctx.params.sessionID,
                objective: ctx.payload.objective,
                acceptanceCriteria: ctx.payload.acceptanceCriteria,
                constraints: ctx.payload.constraints,
                sourceMessageIDs: ctx.payload.sourceMessageIDs,
                expectedVersion: ctx.payload.expectedVersion,
              })
              .pipe(Effect.catchTag("SessionGoal.Conflict", (error) => Effect.fail(conflict(error)))),
          }
        }),
      )
      .handle(
        "session.goal.status",
        Effect.fn(function* (ctx) {
          const goal = yield* SessionGoal.Service
          return {
            data: yield* goal
              .setStatus({
                sessionID: ctx.params.sessionID,
                status: ctx.payload.status,
                expectedVersion: ctx.payload.expectedVersion,
              })
              .pipe(Effect.catchTag("SessionGoal.Conflict", (error) => Effect.fail(conflict(error)))),
          }
        }),
      )
  }),
)
