export * as HistoryTool from "./history"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { SessionHistorySearch } from "../session/history-search"
import { SessionMessage } from "../session/message"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

// Retrieval only, by design: the model chooses to call these, and both calls appear in the
// transcript like any other tool call. The full history is never auto-injected back into context
// -- that would just re-trigger the compaction this exists to recover detail from without.
export const searchName = "history_search"

export const SearchInput = Schema.Struct({
  query: Schema.String,
  limit: Schema.Int.pipe(Schema.optional),
}).annotate({
  description: "Search this session's full history, including content a compaction already summarized away. Returns bounded snippets with the source message ID -- call history_get on a result to read the full message.",
})
export const SearchOutput = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      messageID: SessionMessage.ID,
      seq: Schema.Int,
      role: Schema.String,
      createdAt: Schema.Int,
      snippet: Schema.String,
    }),
  ),
  truncated: Schema.Boolean,
})
export type SearchOutput = typeof SearchOutput.Type

export const getName = "history_get"

export const GetInput = Schema.Struct({
  messageID: SessionMessage.ID,
  before: Schema.Int.pipe(Schema.optional),
  after: Schema.Int.pipe(Schema.optional),
}).annotate({
  description: `Read a bounded neighborhood of full messages around one message ID, usually one cited by history_search. Capped at ${SessionHistorySearch.MaxNeighborhood} messages before/after.`,
})
export const GetOutput = Schema.Struct({
  entries: Schema.Array(Schema.Struct({ seq: Schema.Int, message: SessionMessage.Message })),
})
export type GetOutput = typeof GetOutput.Type

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const { db } = yield* Database.Service

    yield* tools
      .register({
        [searchName]: Tool.make({
          description:
            "Search this session's full history for a term, including content a compaction already summarized away. Returns bounded snippets, not full messages -- call history_get on a result's messageID to read the surrounding context in full.",
          input: SearchInput,
          output: SearchOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output, null, 2) }],
          execute: (input, context) =>
            SessionHistorySearch.search(db, { sessionID: context.sessionID, query: input.query, limit: input.limit }).pipe(
              Effect.mapError(() => new ToolFailure({ message: "History search failed" })),
            ),
        }),
        [getName]: Tool.make({
          description:
            "Read a bounded neighborhood of full messages around one message ID -- the second half of the retrieval flow after history_search finds a candidate by snippet.",
          input: GetInput,
          output: GetOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output, null, 2) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const entries = yield* SessionHistorySearch.get(db, {
                sessionID: context.sessionID,
                messageID: input.messageID,
                before: input.before,
                after: input.after,
              }).pipe(Effect.mapError(() => new ToolFailure({ message: "History read failed" })))
              if (!entries) return yield* Effect.fail(new ToolFailure({ message: `No message ${input.messageID} in this session.` }))
              return { entries }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({ name: "tool/history", layer, deps: [ToolRegistry.node, Database.node] })
