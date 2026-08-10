import { SessionGoal } from "@opencode-ai/schema/session-goal"
import { Session } from "@opencode-ai/schema/session"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { NonNegativeInt } from "@opencode-ai/schema/schema"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { SessionGoalConflictError, SessionNotFoundError } from "../errors"

/**
 * Session-owned, so it follows the question/permission group precedent: its own group, entirely
 * behind sessionLocationMiddleware, rather than folded into the large session group (build post's
 * package-boundary convention -- see FORK.md's PR conventions).
 */
export const makeGoalGroup = <SessionLocationId extends HttpApiMiddleware.AnyId, SessionLocationService>(
  sessionLocationMiddleware: Context.Key<SessionLocationId, SessionLocationService>,
) =>
  HttpApiGroup.make("server.goal")
    .add(
      HttpApiEndpoint.get("session.goal.get", "/api/session/:sessionID/goal", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: SessionGoal.Info.pipe(Schema.optional) }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.goal.get",
            summary: "Get session goal",
            description: "Retrieve the durable goal for a session, if one has been set.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.put("session.goal.update", "/api/session/:sessionID/goal", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          objective: Schema.String,
          acceptanceCriteria: Schema.Array(SessionGoal.AcceptanceCriterion),
          constraints: Schema.Array(SessionGoal.Constraint),
          sourceMessageIDs: Schema.Array(SessionMessage.ID),
          expectedVersion: NonNegativeInt.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: SessionGoal.Info }),
        error: [SessionNotFoundError, SessionGoalConflictError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.goal.update",
            summary: "Replace session goal",
            description:
              "Atomically replace the objective, acceptance criteria, and constraints. Only the user should rewrite the objective or waive a criterion; this endpoint does not distinguish caller identity, so that policy is enforced by the client surface that calls it.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.put("session.goal.status", "/api/session/:sessionID/goal/status", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          status: SessionGoal.Status,
          expectedVersion: NonNegativeInt.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: SessionGoal.Info }),
        error: [SessionNotFoundError, SessionGoalConflictError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.goal.status",
            summary: "Change session goal status",
            description: "Set the goal's status. Completing a goal is a durable state change gated by policy, not inferred from the model alone.",
          }),
        ),
    )
    .annotateMerge(OpenApi.annotations({ title: "session goal", description: "Experimental session goal routes." }))
