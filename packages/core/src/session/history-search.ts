export * as SessionHistorySearch from "./history-search"

import { and, asc, eq, gte, lte, sql } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import type { Database } from "../database/database"
import { SessionCompaction } from "./compaction"
import { MessageDecodeError } from "./error"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionMessageTable } from "./sql"

type DatabaseService = Database.Interface["db"]

/** Hard caps, enforced here rather than trusted to the generic ToolOutputStore backstop -- the
 * ticket asks for "strict result and byte caps" on this surface specifically. */
export const MaxResults = 20
export const MaxSnippetBytes = 500
export const MaxNeighborhood = 20

const decode = Schema.decodeUnknownEffect(SessionMessage.Message)
const decodeMessageRow = (row: typeof SessionMessageTable.$inferSelect) =>
  decode({ ...row.data, id: row.id, type: row.type }).pipe(
    Effect.mapError(
      () =>
        new MessageDecodeError({
          sessionID: SessionSchema.ID.make(row.session_id),
          messageID: SessionMessage.ID.make(row.id),
        }),
    ),
  )

const takePrefixBytes = (input: string, maxBytes: number) => {
  let bytes = 0
  let content = ""
  for (const char of input) {
    const size = Buffer.byteLength(char, "utf8")
    if (bytes + size > maxBytes) break
    content += char
    bytes += size
  }
  return content === input ? content : `${content}...`
}

/**
 * Keep the search index in sync with one message row. Called from the projector on every write
 * (insert or update) that produces a session_message row -- see session/projector.ts.
 *
 * `text` is always a normalized plain-text rendering (SessionCompaction.serialize -- the same
 * renderer compaction summarization uses), never the raw message/event JSON. A message that
 * serializes to nothing (e.g. an assistant turn with no text/tool content yet) is not indexed;
 * DELETE-then-maybe-INSERT keeps this correct for both first-write and re-index-on-update.
 */
export const index = Effect.fn("SessionHistorySearch.index")(function* (
  db: DatabaseService,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly messageID: SessionMessage.ID
    readonly seq: number
    readonly message: SessionMessage.Message
  },
) {
  yield* db
    .run(sql`DELETE FROM session_transcript_search WHERE message_id = ${input.messageID}`)
    .pipe(Effect.orDie)
  const text = SessionCompaction.serialize(input.message)
  if (!text) return
  const createdAt = DateTime.toEpochMillis(input.message.time.created)
  yield* db
    .run(
      sql`INSERT INTO session_transcript_search (session_id, message_id, seq, role, text, created_at)
          VALUES (${input.sessionID}, ${input.messageID}, ${input.seq}, ${input.message.type}, ${text}, ${createdAt})`,
    )
    .pipe(Effect.orDie)
})

export interface SearchResult {
  readonly messageID: SessionMessage.ID
  readonly seq: number
  readonly role: string
  readonly createdAt: number
  readonly snippet: string
}

/**
 * FTS5's MATCH argument is itself a small query language -- unquoted `.`, `-`, `"`, `(`, `)`,
 * `*`, `:` and others are operators, not literal characters, so passing arbitrary user/model text
 * straight through throws "fts5: syntax error" the moment it contains one (caught by this
 * package's own test: searching for an IP address like "10.20.30.40" broke on the first `.`).
 * Wrapping the whole input as one double-quoted FTS5 phrase disables all of that and searches for
 * the literal text (in order) instead -- doubling any embedded `"` is FTS5's own escape for a
 * literal quote inside a phrase, the same convention SQL string literals use.
 */
const asPhraseQuery = (query: string) => `"${query.replaceAll('"', '""')}"`

/**
 * Full-history search, deliberately bypassing the compaction-boundary filter every other
 * SessionHistory query applies (session/history.ts) -- the entire point is reaching content a
 * compaction already excluded from the active context.
 */
export const search = Effect.fn("SessionHistorySearch.search")(function* (
  db: DatabaseService,
  input: { readonly sessionID: SessionSchema.ID; readonly query: string; readonly limit?: number },
) {
  const limit = Math.max(1, Math.min(input.limit ?? MaxResults, MaxResults))
  const rows = yield* db
    .all<{ message_id: string; seq: number; role: string; created_at: number; snippet: string }>(
      sql`SELECT message_id, seq, role, created_at,
                 snippet(session_transcript_search, 4, '', '', '...', 24) AS snippet
          FROM session_transcript_search
          WHERE session_id = ${input.sessionID} AND session_transcript_search MATCH ${asPhraseQuery(input.query)}
          ORDER BY rank
          LIMIT ${limit + 1}`,
    )
    .pipe(Effect.orDie)
  const truncated = rows.length > limit
  const results: SearchResult[] = rows.slice(0, limit).map((row) => ({
    messageID: SessionMessage.ID.make(row.message_id),
    seq: row.seq,
    role: row.role,
    createdAt: row.created_at,
    snippet: takePrefixBytes(row.snippet, MaxSnippetBytes),
  }))
  return { results, truncated }
})

/**
 * A bounded neighborhood of full messages around one cited message -- the second half of the
 * retrieval flow: search() finds a candidate by snippet, get() reads its actual content.
 */
export const get = Effect.fn("SessionHistorySearch.get")(function* (
  db: DatabaseService,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly messageID: SessionMessage.ID
    readonly before?: number
    readonly after?: number
  },
) {
  const target = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.messageID)))
    .get()
    .pipe(Effect.orDie)
  if (!target) return undefined
  const before = Math.max(0, Math.min(input.before ?? 5, MaxNeighborhood))
  const after = Math.max(0, Math.min(input.after ?? 5, MaxNeighborhood))
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, input.sessionID),
        gte(SessionMessageTable.seq, target.seq - before),
        lte(SessionMessageTable.seq, target.seq + after),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  return yield* Effect.forEach(rows, (row) =>
    decodeMessageRow(row).pipe(Effect.map((message) => ({ seq: row.seq, message }))),
  )
})
