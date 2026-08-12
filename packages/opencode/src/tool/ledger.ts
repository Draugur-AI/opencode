import { Effect, Schema } from "effect"
import { SessionLedger } from "@opencode-ai/core/session/ledger"
import { SessionMessage } from "@opencode-ai/core/session/message"
import * as Tool from "./tool"

// V1 bridge for the V2 Ledger tool (packages/core/src/tool/ledger.ts) -- see monitor.ts's
// header for why this bridge exists. Delegates to the same SessionLedger.Service the V2 tool
// uses. Adding is the model-facing mutation; superseding an entry is a user action from the
// ledger panel, not exposed to the model here.

export const AddParameters = Schema.Struct({
  kind: SessionLedger.Kind,
  text: Schema.String,
}).annotate({
  description:
    "Record one fact that must remain true while continuing this task: a decision, a discovered constraint, a finding, a risk, or a next step.",
})

export const LedgerAddTool = Tool.define(
  "ledger_add",
  Effect.gen(function* () {
    const ledger = yield* SessionLedger.Service

    return {
      description:
        "Add one entry to the session's working ledger -- a decision, constraint, fact, risk, or next step worth remembering across compaction. The ledger has a bounded budget; if it is full, supersede an existing entry first (from the ledger panel) rather than expecting this call to silently drop something.",
      parameters: AddParameters,
      execute: (params: Schema.Schema.Type<typeof AddParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "ledger_add",
            patterns: ["*"],
            always: ["*"],
            metadata: { kind: params.kind },
          })
          const entry = yield* ledger
            .add({
              sessionID: ctx.sessionID,
              kind: params.kind,
              text: params.text,
              sourceMessageIDs: [SessionMessage.ID.make(ctx.messageID)],
            })
            .pipe(
              Effect.catchTag("SessionLedger.CapExceededError", (error) =>
                Effect.die(
                  new Error(
                    `Ledger is at its budget (${error.activeCount} entries, ${error.activeBytes} bytes active) -- supersede an existing entry before adding another.`,
                  ),
                ),
              ),
            )
          return {
            title: "Ledger entry added",
            output: JSON.stringify({ entry }, null, 2),
            metadata: { entryID: entry.id },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
