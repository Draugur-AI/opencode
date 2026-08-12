import { Effect, Schema } from "effect"
import { SessionGoal } from "@opencode-ai/core/session/goal"
import * as Tool from "./tool"

// V1 bridge for the V2 Goal tool (packages/core/src/tool/goal.ts) -- see monitor.ts's header
// for why this bridge exists. Delegates to the same SessionGoal.Service the V2 tool uses.

export const GetParameters = Schema.Struct({})

export const GoalGetTool = Tool.define(
  "goal_get",
  Effect.gen(function* () {
    const goal = yield* SessionGoal.Service

    return {
      description:
        "Read the session's durable goal: objective, acceptance criteria, and constraints. This is typed state, not conversation recall -- it survives compaction. Call this instead of trusting the summary when you need the exact objective or a constraint's exact wording.",
      parameters: GetParameters,
      execute: (_params: Schema.Schema.Type<typeof GetParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const current = yield* goal.get(ctx.sessionID)
          return {
            title: current ? "Session goal" : "No goal set",
            output: current ? JSON.stringify(current, null, 2) : "No goal is set for this session.",
            metadata: { hasGoal: !!current },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const UpdateProgressParameters = Schema.Struct({
  criterionID: SessionGoal.AcceptanceCriterion.fields.id,
}).annotate({
  description: "Mark one acceptance criterion as met. The criterion must currently be open.",
})

export const GoalUpdateProgressTool = Tool.define(
  "goal_update_progress",
  Effect.gen(function* () {
    const goal = yield* SessionGoal.Service

    return {
      description:
        "Mark one acceptance criterion as met, once you have verified it. Cannot rewrite the objective, constraints, or waive a criterion -- those require the user.",
      parameters: UpdateProgressParameters,
      execute: (params: Schema.Schema.Type<typeof UpdateProgressParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "goal_update_progress",
            patterns: ["*"],
            always: ["*"],
            metadata: { criterionID: params.criterionID },
          })
          const current = yield* goal.get(ctx.sessionID)
          if (!current) throw new Error("No goal is set for this session.")
          const target = current.acceptanceCriteria.find((c) => c.id === params.criterionID)
          if (!target) throw new Error(`No acceptance criterion with id ${params.criterionID}.`)
          if (target.status !== "open") throw new Error(`Criterion ${params.criterionID} is already ${target.status}, not open.`)
          const updated = yield* goal
            .update({
              sessionID: ctx.sessionID,
              objective: current.objective,
              acceptanceCriteria: current.acceptanceCriteria.map((c) =>
                c.id === params.criterionID ? { ...c, status: "met" as const } : c,
              ),
              constraints: current.constraints,
              sourceMessageIDs: current.sourceMessageIDs,
              expectedVersion: current.version,
            })
            .pipe(
              Effect.catchTag("SessionGoal.Conflict", () =>
                Effect.die(new Error("The goal changed concurrently. Re-read it with goal_get and retry.")),
              ),
            )
          return {
            title: `Criterion ${params.criterionID} marked met`,
            output: JSON.stringify(updated, null, 2),
            metadata: { criterionID: params.criterionID },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
