import { Session } from "@opencode-ai/schema/session"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { NonNegativeInt } from "@opencode-ai/schema/schema"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { MessageNotFoundError, SessionNotFoundError, UnknownError } from "../errors"

export const SearchResult = Schema.Struct({
  messageID: SessionMessage.ID,
  seq: Schema.Int,
  role: Schema.String,
  createdAt: Schema.Int,
  snippet: Schema.String,
}).annotate({ identifier: "Session.History.SearchResult" })

export const HistoryEntry = Schema.Struct({
  seq: Schema.Int,
  message: SessionMessage.Message,
}).annotate({ identifier: "Session.History.Entry" })

export const makeHistoryGroup = <SessionLocationId extends HttpApiMiddleware.AnyId, SessionLocationService>(
  sessionLocationMiddleware: Context.Key<SessionLocationId, SessionLocationService>,
) =>
  HttpApiGroup.make("server.history")
    .add(
      HttpApiEndpoint.get("session.history.search", "/api/session/:sessionID/history/search", {
        params: { sessionID: Session.ID },
        query: Schema.Struct({
          query: Schema.String,
          limit: NonNegativeInt.pipe(Schema.optional),
        }),
        success: Schema.Struct({
          data: Schema.Struct({ results: Schema.Array(SearchResult), truncated: Schema.Boolean }),
        }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.history.search",
            summary: "Search session history",
            description:
              "Full-text search over this session's entire message history, including content a compaction already excluded from the active context. Returns bounded snippets, not full messages.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.history.get", "/api/session/:sessionID/history/:messageID", {
        params: { sessionID: Session.ID, messageID: SessionMessage.ID },
        query: Schema.Struct({
          before: NonNegativeInt.pipe(Schema.optional),
          after: NonNegativeInt.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: Schema.Array(HistoryEntry) }),
        error: [SessionNotFoundError, MessageNotFoundError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.history.get",
            summary: "Read a bounded history neighborhood",
            description:
              "Read a bounded neighborhood of full messages around one message ID -- the second half of the retrieval flow after session.history.search finds a candidate by snippet.",
          }),
        ),
    )
    .annotateMerge(
      OpenApi.annotations({ title: "session history", description: "Experimental session history search routes." }),
    )
