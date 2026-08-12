import { Effect, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionHistorySearch } from "@opencode-ai/core/session/history-search"
import { SessionMessage } from "@opencode-ai/core/session/message"
import * as Tool from "./tool"

// V1 bridge for the V2 History tools (packages/core/src/tool/history.ts) -- see monitor.ts's
// header for why this bridge exists. Delegates to the same SessionHistorySearch functions the
// V2 tool uses; read-only, no permission ask (matches the V2 tool).

export const SearchParameters = Schema.Struct({
  query: Schema.String,
  limit: Schema.Int.pipe(Schema.optional),
}).annotate({
  description:
    "Search this session's full history, including content a compaction already summarized away. Returns bounded snippets with the source message ID -- call history_get on a result to read the full message. Use this whenever the user references something specific you don't currently see in context -- it may have been summarized away rather than never discussed.",
})

export const HistorySearchTool = Tool.define(
  "history_search",
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    return {
      description:
        "Search this session's full history for a term, including content a compaction already summarized away. Returns bounded snippets, not full messages -- call history_get on a result's messageID to read the surrounding context in full. Use this whenever the user references something specific you don't currently see in context -- it may have been summarized away rather than never discussed.",
      parameters: SearchParameters,
      execute: (params: Schema.Schema.Type<typeof SearchParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const result = yield* SessionHistorySearch.search(db, {
            sessionID: ctx.sessionID,
            query: params.query,
            limit: params.limit,
          })
          return {
            title: `${result.results.length} result${result.results.length === 1 ? "" : "s"}`,
            output: JSON.stringify(result, null, 2),
            metadata: { count: result.results.length, truncated: result.truncated },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const GetParameters = Schema.Struct({
  messageID: SessionMessage.ID,
  before: Schema.Int.pipe(Schema.optional),
  after: Schema.Int.pipe(Schema.optional),
}).annotate({
  description: `Read a bounded neighborhood of full messages around one message ID, usually one cited by history_search. Capped at ${SessionHistorySearch.MaxNeighborhood} messages before/after.`,
})

export const HistoryGetTool = Tool.define(
  "history_get",
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    return {
      description:
        "Read a bounded neighborhood of full messages around one message ID -- the second half of the retrieval flow after history_search finds a candidate by snippet.",
      parameters: GetParameters,
      execute: (params: Schema.Schema.Type<typeof GetParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const entries = yield* SessionHistorySearch.get(db, {
            sessionID: ctx.sessionID,
            messageID: params.messageID,
            before: params.before,
            after: params.after,
          })
          if (!entries) throw new Error(`No message ${params.messageID} in this session.`)
          return {
            title: `${entries.length} message${entries.length === 1 ? "" : "s"}`,
            output: JSON.stringify(entries, null, 2),
            metadata: { count: entries.length },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
