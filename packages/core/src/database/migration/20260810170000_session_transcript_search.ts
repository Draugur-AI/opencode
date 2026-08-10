import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260810170000_session_transcript_search",
  up(tx) {
    return Effect.gen(function* () {
      // FTS5 is compiled into both drivers this repo ships (bun:sqlite and node:sqlite --
      // confirmed empirically, see TKT-318 diary). Not a drizzle sqliteTable(): drizzle's
      // sqliteTable() builder has no FTS5 virtual-table support, so this is hand-written raw SQL,
      // same convention as 20260810124427_session_lifecycle's backfill. session_id/message_id/seq
      // /role/created_at are UNINDEXED -- they're metadata for filtering and citing a result, not
      // searchable text -- so only `text` gets tokenized. `text` is always a normalized plain-text
      // rendering of a message (see session/history-search.ts), never the raw event/message JSON.
      yield* tx.run(`
        CREATE VIRTUAL TABLE \`session_transcript_search\` USING fts5(
          session_id UNINDEXED,
          message_id UNINDEXED,
          seq UNINDEXED,
          role UNINDEXED,
          text,
          created_at UNINDEXED
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
