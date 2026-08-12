import { ConfigDocument } from "@opencode-ai/core/config/document"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { ConfigDocumentConflictError, ConfigDocumentTargetNotFoundError, InvalidRequestError } from "@opencode-ai/protocol/errors"
import { response } from "../location"

const notFound = (error: ConfigDocument.TargetNotFoundError) =>
  new ConfigDocumentTargetNotFoundError({ id: error.id, message: `No config document target with id ${error.id}` })

export const ConfigDocumentHandler = HttpApiBuilder.group(Api, "server.config-document", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "config.document.target.list",
        Effect.fn(function* () {
          const documents = yield* ConfigDocument.Service
          return yield* response(documents.listTargets())
        }),
      )
      .handle(
        "config.document.target.read",
        Effect.fn(function* (ctx) {
          const documents = yield* ConfigDocument.Service
          return yield* response(documents.readTarget(ctx.params.targetID).pipe(Effect.mapError(notFound)))
        }),
      )
      .handle(
        "config.document.effective.get",
        Effect.fn(function* () {
          const documents = yield* ConfigDocument.Service
          return yield* response(documents.effective())
        }),
      )
      .handle(
        "config.document.target.validate",
        Effect.fn(function* (ctx) {
          const documents = yield* ConfigDocument.Service
          return yield* response(
            documents.validatePatch(ctx.params.targetID, ctx.payload.patch).pipe(Effect.mapError(notFound)),
          )
        }),
      )
      .handle(
        "config.document.target.apply",
        Effect.fn(function* (ctx) {
          const documents = yield* ConfigDocument.Service
          return yield* response(
            documents.applyPatch(ctx.params.targetID, ctx.payload.expectedHash, ctx.payload.patch).pipe(
              Effect.mapError((error) => {
                switch (error._tag) {
                  case "Config.Document.TargetNotFoundError":
                    return notFound(error)
                  case "Config.Document.StaleHashError":
                    return new ConfigDocumentConflictError({
                      id: error.id,
                      expectedHash: error.expected,
                      actualHash: error.actual,
                      message: "The target changed on disk since it was last read",
                    })
                  case "Config.Document.RedactedValueRejectedError":
                    return new InvalidRequestError({
                      message:
                        "This patch would write the redaction placeholder over a secret field -- read the real value from the config file directly if you need to edit it",
                      field: "patch",
                      kind: error.id,
                    })
                }
              }),
            ),
          )
        }),
      )
  }),
)
