import { SessionLedger } from "@opencode-ai/core/session/ledger"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { SessionLedgerCapExceededError, SessionLedgerEntryNotFoundError } from "@opencode-ai/protocol/errors"

export const LedgerHandler = HttpApiBuilder.group(Api, "server.ledger", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "session.ledger.list",
        Effect.fn(function* (ctx) {
          const ledger = yield* SessionLedger.Service
          return { data: yield* ledger.list(ctx.params.sessionID, { status: ctx.query.status }) }
        }),
      )
      .handle(
        "session.ledger.add",
        Effect.fn(function* (ctx) {
          const ledger = yield* SessionLedger.Service
          return {
            data: yield* ledger
              .add({
                sessionID: ctx.params.sessionID,
                kind: ctx.payload.kind,
                text: ctx.payload.text,
                sourceMessageIDs: ctx.payload.sourceMessageIDs,
              })
              .pipe(
                Effect.catchTag(
                  "SessionLedger.CapExceededError",
                  (error) =>
                    new SessionLedgerCapExceededError({
                      sessionID: error.sessionID,
                      activeCount: error.activeCount,
                      activeBytes: error.activeBytes,
                      message: `Ledger is at its budget (${error.activeCount} entries, ${error.activeBytes} bytes active)`,
                    }),
                ),
              ),
          }
        }),
      )
      .handle(
        "session.ledger.supersede",
        Effect.fn(function* (ctx) {
          const ledger = yield* SessionLedger.Service
          yield* ledger
            .supersede({
              sessionID: ctx.params.sessionID,
              entryID: ctx.params.entryID,
              supersededBy: ctx.payload.supersededBy,
            })
            .pipe(
              Effect.catchTag(
                "SessionLedger.EntryNotFoundError",
                (error) =>
                  new SessionLedgerEntryNotFoundError({
                    sessionID: ctx.params.sessionID,
                    entryID: error.entryID,
                    message: `No active ledger entry ${error.entryID}`,
                  }),
              ),
            )
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
