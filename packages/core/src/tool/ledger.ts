export * as LedgerTool from "./ledger"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { SessionLedger } from "../session/ledger"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

// Adding is the model-facing mutation. Superseding an entry is a user action from the ledger
// panel (per the ticket's UI scope), not exposed to the model here -- keeps the model's ledger
// surface to "record a fact", not "curate history".
export const addName = "ledger_add"

export const AddInput = Schema.Struct({
  kind: SessionLedger.Kind,
  text: Schema.String,
}).annotate({
  description: "Record one fact that must remain true while continuing this task: a decision, a discovered constraint, a finding, a risk, or a next step.",
})
export const AddOutput = Schema.Struct({ entry: SessionLedger.Entry })
export type AddOutput = typeof AddOutput.Type

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const ledger = yield* SessionLedger.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [addName]: Tool.make({
          description:
            "Add one entry to the session's working ledger -- a decision, constraint, fact, risk, or next step worth remembering across compaction. The ledger has a bounded budget; if it is full, supersede an existing entry first (from the ledger panel) rather than expecting this call to silently drop something.",
          input: AddInput,
          output: AddOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output.entry, null, 2) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: addName,
                resources: ["*"],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const entry = yield* ledger
                .add({
                  sessionID: context.sessionID,
                  kind: input.kind,
                  text: input.text,
                  sourceMessageIDs: [context.assistantMessageID],
                })
                .pipe(
                  Effect.catchTag(
                    "SessionLedger.CapExceededError",
                    (error) =>
                      new ToolFailure({
                        message: `Ledger is at its budget (${error.activeCount} entries, ${error.activeBytes} bytes active) -- supersede an existing entry before adding another.`,
                      }),
                  ),
                )
              return { entry }
            }).pipe(
              Effect.mapError((error) => (error instanceof ToolFailure ? error : new ToolFailure({ message: "Unable to add ledger entry" }))),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/ledger",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, SessionLedger.node],
})
