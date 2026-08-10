export * as GoalTool from "./goal"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { SessionGoal } from "../session/goal"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

// Read-only. Never registered as needing permission -- a goal is context, not an action.
export const getName = "goal_get"

export const GetInput = Schema.Struct({})
export const GetOutput = Schema.Struct({ goal: SessionGoal.Info.pipe(Schema.optional) })
export type GetOutput = typeof GetOutput.Type

// Deliberately narrow: only "open" -> "met" on one existing criterion. Rewriting the objective or
// constraints, adding/removing criteria, or waiving a criterion are NOT reachable from this tool --
// the design post reserves those to the user (waive) or to the user/harness completion policy
// (objective rewrite), so this tool cannot express them even if a model asks it to.
export const updateProgressName = "goal_update_progress"

export const UpdateProgressInput = Schema.Struct({
  criterionID: SessionGoal.AcceptanceCriterion.fields.id,
}).annotate({
  description: "Mark one acceptance criterion as met. The criterion must currently be open.",
})
export const UpdateProgressOutput = Schema.Struct({ goal: SessionGoal.Info })
export type UpdateProgressOutput = typeof UpdateProgressOutput.Type

export class CriterionNotOpenError extends Schema.TaggedErrorClass<CriterionNotOpenError>()(
  "GoalTool.CriterionNotOpenError",
  { criterionID: Schema.String },
) {}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const goal = yield* SessionGoal.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [getName]: Tool.make({
          description:
            "Read the session's durable goal: objective, acceptance criteria, and constraints. This is typed state, not conversation recall -- it survives compaction. Call this instead of trusting the summary when you need the exact objective or a constraint's exact wording.",
          input: GetInput,
          output: GetOutput,
          toModelOutput: ({ output }) => [
            { type: "text", text: output.goal ? JSON.stringify(output.goal, null, 2) : "No goal is set for this session." },
          ],
          execute: (_input, context) =>
            Effect.gen(function* () {
              const current = yield* goal.get(context.sessionID)
              return { goal: current }
            }),
        }),
        [updateProgressName]: Tool.make({
          description:
            "Mark one acceptance criterion as met, once you have verified it. Cannot rewrite the objective, constraints, or waive a criterion -- those require the user.",
          input: UpdateProgressInput,
          output: UpdateProgressOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output.goal, null, 2) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: updateProgressName,
                resources: ["*"],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const current = yield* goal.get(context.sessionID)
              if (!current) return yield* Effect.fail(new ToolFailure({ message: "No goal is set for this session." }))
              const target = current.acceptanceCriteria.find((c) => c.id === input.criterionID)
              if (!target)
                return yield* Effect.fail(new ToolFailure({ message: `No acceptance criterion with id ${input.criterionID}.` }))
              if (target.status !== "open")
                return yield* Effect.fail(
                  new ToolFailure({ message: `Criterion ${input.criterionID} is already ${target.status}, not open.` }),
                )
              const updated = yield* goal.update({
                sessionID: context.sessionID,
                objective: current.objective,
                acceptanceCriteria: current.acceptanceCriteria.map((c) =>
                  c.id === input.criterionID ? { ...c, status: "met" as const } : c,
                ),
                constraints: current.constraints,
                sourceMessageIDs: current.sourceMessageIDs,
                expectedVersion: current.version,
              })
              return { goal: updated }
            }).pipe(
              Effect.catchTag("SessionGoal.Conflict", () =>
                new ToolFailure({ message: "The goal changed concurrently. Re-read it with goal_get and retry." }),
              ),
              Effect.mapError((error) => (error instanceof ToolFailure ? error : new ToolFailure({ message: "Unable to update goal progress" }))),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/goal",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, SessionGoal.node],
})
