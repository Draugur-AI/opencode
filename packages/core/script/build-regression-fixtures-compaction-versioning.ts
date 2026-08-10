#!/usr/bin/env bun
/**
 * Regenerates fixtures/regression-corpus/db/compaction-versioned-events.db.
 *
 * Run from packages/core: `bun run script/build-regression-fixtures-compaction-versioning.ts`
 *
 * TKT-318 closes the gap TKT-308's baseline.db left open (see its README): "no event type has
 * been bumped past .1 anywhere in this snapshot, so a genuinely-superseded decoder is not
 * fixturable yet." Compaction.Ended is now the first one (packages/schema/src/session-event.ts:
 * Compaction.EndedV1 kept for decode only, Compaction.Ended bumped to durable version 2 with
 * telemetry fields). This is a SEPARATE fixture file, not an edit to baseline.db -- the corpus
 * rule is additive, see ../../../fixtures/regression-corpus/README.md.
 *
 * The story: one session compacted twice, once by a pre-slice-5 binary (version 1: reason/text/
 * recent only) and once by the current binary (version 2: same fields plus tokensBefore/
 * retainedTailMessages/retainedTailTokens/summaryBytes/summaryTokens/durationMs/sourceSeqStart/
 * sourceSeqEnd) -- exactly what a session that lived across the upgrade would contain. Both rows
 * must decode; see packages/core/test/session-compaction-versioning.test.ts for the same property
 * proven directly against the live event service (this file is the corpus's frozen-input twin of
 * that live-decode proof, not a replacement for it).
 */
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { existsSync, unlinkSync } from "fs"
import { fileURLToPath } from "url"

const outPath = fileURLToPath(
  new URL("../../../fixtures/regression-corpus/db/compaction-versioned-events.db", import.meta.url),
)
for (const suffix of ["", "-wal", "-shm"]) {
  const p = outPath + suffix
  if (existsSync(p)) unlinkSync(p)
}

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

const T0 = 1735689600000 // 2025-01-01T00:00:00Z — fixed so the fixture is byte-stable across regenerations

await Effect.runPromise(
  Effect.gen(function* () {
    const db = yield* makeDb
    yield* db.run(sql`PRAGMA foreign_keys = ON`)
    yield* DatabaseMigration.apply(db)

    yield* db.run(sql`
      INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes)
      VALUES ('git-remote:github.com/draugur-ai/opencode', '/home/user/opencode', 'git', 'opencode',
              ${T0}, ${T0}, '[]')
    `)
    yield* db.run(sql`
      INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
      VALUES ('ses_compacted_twice00000', 'git-remote:github.com/draugur-ai/opencode', 'compacted-twice-session',
              '/home/user/opencode', 'Long-lived session spanning the slice-5 upgrade', 'fixture', ${T0}, ${
                T0 + 100_000
              })
    `)

    yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('ses_compacted_twice00000', 1)`)

    // seq 0: a compaction from before slice 5 -- version 1, no telemetry fields.
    yield* db.run(sql`
      INSERT INTO event (id, aggregate_id, seq, type, data)
      VALUES ('evt_compaction_v1000000', 'ses_compacted_twice00000', 0, 'session.next.compaction.ended.1', ${JSON.stringify(
        {
          timestamp: T0 + 10_000,
          sessionID: "ses_compacted_twice00000",
          messageID: "msg_compaction_v1000000",
          reason: "auto",
          text: "Pre-upgrade summary: no telemetry fields existed yet.",
          recent: "",
        },
      )})
    `)

    // seq 1: a compaction from after slice 5 -- version 2, full telemetry.
    yield* db.run(sql`
      INSERT INTO event (id, aggregate_id, seq, type, data)
      VALUES ('evt_compaction_v2000000', 'ses_compacted_twice00000', 1, 'session.next.compaction.ended.2', ${JSON.stringify(
        {
          timestamp: T0 + 90_000,
          sessionID: "ses_compacted_twice00000",
          messageID: "msg_compaction_v2000000",
          reason: "auto",
          text: "Post-upgrade summary: telemetry fields are present.",
          recent: "",
          tokensBefore: 12_000,
          retainedTailMessages: 3,
          retainedTailTokens: 900,
          summaryBytes: 512,
          summaryTokens: 128,
          durationMs: 4200,
          sourceSeqStart: 0,
          sourceSeqEnd: 40,
        },
      )})
    `)

    console.log(`wrote ${outPath}`)
  }).pipe(Effect.provide(SqliteClient.layer({ filename: outPath, disableWAL: true })), Effect.scoped),
)
