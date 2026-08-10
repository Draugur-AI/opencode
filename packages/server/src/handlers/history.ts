import { Database } from "@opencode-ai/core/database/database"
import { SessionHistorySearch } from "@opencode-ai/core/session/history-search"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { MessageNotFoundError, UnknownError } from "@opencode-ai/protocol/errors"

export const HistoryHandler = HttpApiBuilder.group(Api, "server.history", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "session.history.search",
        Effect.fn(function* (ctx) {
          const { db } = yield* Database.Service
          const data = yield* SessionHistorySearch.search(db, {
            sessionID: ctx.params.sessionID,
            query: ctx.query.query,
            limit: ctx.query.limit,
          })
          return { data }
        }),
      )
      .handle(
        "session.history.get",
        Effect.fn(function* (ctx) {
          const { db } = yield* Database.Service
          const entries = yield* SessionHistorySearch.get(db, {
            sessionID: ctx.params.sessionID,
            messageID: ctx.params.messageID,
            before: ctx.query.before,
            after: ctx.query.after,
          }).pipe(
            // Same precedent as session.message/session.context: a message that fails to decode
            // is a server-side data problem, not something the caller can act on -- log a
            // reference and surface a generic error rather than leaking decode internals.
            Effect.catchTag("Session.MessageDecodeError", (error) => {
              const ref = `err_${crypto.randomUUID().slice(0, 8)}`
              return Effect.logError("failed to decode session message").pipe(
                Effect.annotateLogs({ ref, sessionID: error.sessionID, messageID: error.messageID }),
                Effect.andThen(
                  Effect.fail(
                    new UnknownError({ message: "Unexpected server error. Check server logs for details.", ref }),
                  ),
                ),
              )
            }),
          )
          if (!entries)
            return yield* new MessageNotFoundError({
              sessionID: ctx.params.sessionID,
              messageID: ctx.params.messageID,
              message: `Message not found: ${ctx.params.messageID}`,
            })
          return { data: entries }
        }),
      )
  }),
)
