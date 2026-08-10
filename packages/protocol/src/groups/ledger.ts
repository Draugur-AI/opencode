import { SessionLedger } from "@opencode-ai/schema/session-ledger"
import { Session } from "@opencode-ai/schema/session"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { SessionLedgerCapExceededError, SessionLedgerEntryNotFoundError, SessionNotFoundError } from "../errors"

export const makeLedgerGroup = <SessionLocationId extends HttpApiMiddleware.AnyId, SessionLocationService>(
  sessionLocationMiddleware: Context.Key<SessionLocationId, SessionLocationService>,
) =>
  HttpApiGroup.make("server.ledger")
    .add(
      HttpApiEndpoint.get("session.ledger.list", "/api/session/:sessionID/ledger", {
        params: { sessionID: Session.ID },
        query: Schema.Struct({
          status: Schema.Literals(["active", "superseded", "all"]).pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: Schema.Array(SessionLedger.Entry) }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.ledger.list",
            summary: "List working ledger entries",
            description: "Retrieve ledger entries for a session. Defaults to active entries only.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.ledger.add", "/api/session/:sessionID/ledger", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          kind: SessionLedger.Kind,
          text: Schema.String,
          sourceMessageIDs: Schema.Array(SessionMessage.ID),
        }),
        success: Schema.Struct({ data: SessionLedger.Entry }),
        error: [SessionNotFoundError, SessionLedgerCapExceededError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.ledger.add",
            summary: "Add a working ledger entry",
            description:
              "Record one fact worth remembering across compaction. Refuses once the active ledger is at its bounded budget -- supersede an entry first.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.ledger.supersede", "/api/session/:sessionID/ledger/:entryID/supersede", {
        params: { sessionID: Session.ID, entryID: SessionLedger.ID },
        payload: Schema.Struct({ supersededBy: SessionLedger.ID }),
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, SessionLedgerEntryNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.ledger.supersede",
            summary: "Supersede a working ledger entry",
            description: "Mark an active entry superseded by a newer one. The superseded entry stays queryable but is excluded from rendered context.",
          }),
        ),
    )
    .annotateMerge(
      OpenApi.annotations({ title: "session ledger", description: "Experimental session ledger routes." }),
    )
