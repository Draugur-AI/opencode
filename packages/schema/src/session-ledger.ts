export * as SessionLedger from "./session-ledger"

import { Schema } from "effect"
import { ascending } from "./identifier"
import { DateTimeUtcFromMillis, optional, statics } from "./schema"
import { SessionID } from "./session-id"
import { SessionMessage } from "./session-message"

export const ID = Schema.String.check(Schema.isStartsWith("ledger_")).pipe(
  Schema.brand("Session.Ledger.ID"),
  statics((schema) => ({ create: () => schema.make("ledger_" + ascending()) })),
)
export type ID = typeof ID.Type

export const Kind = Schema.Literals(["decision", "constraint", "fact", "risk", "next-step"])
export type Kind = typeof Kind.Type

export const EntryStatus = Schema.Literals(["active", "superseded"])
export type EntryStatus = typeof EntryStatus.Type

// One fact worth remembering across compaction: a decision made, a constraint discovered, a
// finding, a risk, or what's next. Entries are never edited in place -- a correction supersedes
// the old entry (superseded stays queryable, just excluded from the rendered context) rather than
// rewriting history.
export interface Entry extends Schema.Schema.Type<typeof Entry> {}
export const Entry = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  kind: Kind,
  text: Schema.String,
  sourceMessageIDs: Schema.Array(SessionMessage.ID),
  status: EntryStatus,
  supersededBy: ID.pipe(optional),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
  }),
}).annotate({ identifier: "Session.Ledger.Entry" })
