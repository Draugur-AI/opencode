import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { EventV2 } from "@opencode-ai/core/event"
import { Effect, Stream } from "effect"
import { sql } from "drizzle-orm"
import { tmpdir } from "./fixture/tmpdir"

// The versioned regression corpus (see ../../../fixtures/regression-corpus/README.md).
// This is the "smoke loader" the corpus's done-condition requires: load baseline.db with
// the current binary and record its public projections. It intentionally operates on a
// COPY, never the committed file, since DatabaseMigration.apply() writes bookkeeping rows
// even when there is nothing new to migrate.
const baselinePath = fileURLToPath(
  new URL("../../../fixtures/regression-corpus/db/baseline.db", import.meta.url),
)

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

describe("regression corpus: db/baseline.db", () => {
  test("loads at baseline and its public projections match the recorded fixture", async () => {
    await using tmp = await tmpdir()
    const copyPath = path.join(tmp.path, "baseline-copy.db")
    await fs.copyFile(baselinePath, copyPath)

    const projections = await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`PRAGMA foreign_keys = ON`)

        // The fixture is already fully migrated -- this must be a no-op, not a failure.
        // A future migration that can't apply cleanly to this fixture is exactly the
        // regression this smoke test exists to catch.
        yield* DatabaseMigration.apply(db)

        const projects = yield* db.all<{ id: string; worktree: string }>(
          sql`SELECT id, worktree FROM project ORDER BY id`,
        )
        const sessions = yield* db.all<{ id: string; project_id: string; title: string; time_archived: number | null }>(
          sql`SELECT id, project_id, title, time_archived FROM session ORDER BY id`,
        )
        const v1MessageCount = yield* db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM message`)
        const v1PartCount = yield* db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM part`)
        const v2ByType = yield* db.all<{ type: string; n: number }>(
          sql`SELECT type, COUNT(*) AS n FROM session_message GROUP BY type ORDER BY type`,
        )
        const events = yield* db.all<{ id: string; seq: number; type: string; data: string }>(
          sql`SELECT id, seq, type, data FROM event ORDER BY seq`,
        )
        const eventSequence = yield* db.get<{ aggregate_id: string; seq: number }>(
          sql`SELECT aggregate_id, seq FROM event_sequence`,
        )
        const compaction = yield* db.get<{ data: string }>(
          sql`SELECT data FROM session_message WHERE type = 'compaction' LIMIT 1`,
        )

        return { projects, sessions, v1MessageCount, v1PartCount, v2ByType, events, eventSequence, compaction }
      }).pipe(Effect.provide(SqliteClient.layer({ filename: copyPath, disableWAL: true })), Effect.scoped),
    )

    // Public projections recorded at fixture-authoring time. A change here on a future
    // run means either the fixture changed (it must not -- see the corpus README) or a
    // migration altered how existing rows decode, which is exactly what this gate
    // is meant to surface.
    expect(projections.projects).toEqual([
      { id: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", worktree: "/home/user/legacy-repo" },
      { id: "git-remote:github.com/draugur-ai/opencode", worktree: "/home/user/opencode" },
    ])

    expect(projections.sessions).toEqual([
      {
        id: "ses_active0000000000000000",
        project_id: "git-remote:github.com/draugur-ai/opencode",
        title: "Fix the login bug",
        time_archived: null,
      },
      {
        id: "ses_archived000000000000",
        project_id: "git-remote:github.com/draugur-ai/opencode",
        title: "Old refactor spike",
        time_archived: 1735689800000,
      },
      {
        id: "ses_legacydir00000000000",
        project_id: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        title: "Pre-worktree-tracking session",
        time_archived: null,
      },
    ])

    // One active + one archived session is the (a) fixture class's minimum bar; the
    // legacy-directory session's malformed-but-readable rows are asserted below instead
    // of here, since their content (not their existence) is the interesting property.
    expect(projections.sessions.filter((s) => s.time_archived === null)).toHaveLength(2)
    expect(projections.sessions.filter((s) => s.time_archived !== null)).toHaveLength(1)

    expect(projections.v1MessageCount?.n).toBe(3) // includes the sparse `data: '{}'` legacy row
    expect(projections.v1PartCount?.n).toBe(3) // includes the sparse `data: '{}'` legacy row

    expect(projections.v2ByType).toEqual([
      { type: "assistant", n: 1 },
      { type: "compaction", n: 1 },
      { type: "user", n: 1 },
    ])

    const compactionData = JSON.parse(projections.compaction!.data)
    expect(compactionData.reason).toBe("auto")
    expect(compactionData.summary).toContain("500")

    // Durable event log: a normal versioned event, then the old-event-decoder case --
    // a versioned type with a sparse `data: '{}'` payload (the same shape
    // database-migration.test.ts already relies on decoding). DatabaseMigration.apply()
    // above already proved this loads without dying; this proves it's still readable.
    expect(projections.eventSequence).toEqual({ aggregate_id: "ses_active0000000000000000", seq: 1 })
    expect(projections.events).toEqual([
      {
        id: "evt_created0000000000000",
        seq: 0,
        type: "session.created.1",
        data: JSON.stringify({ sessionID: "ses_active0000000000000000", info: { title: "Fix the login bug" } }),
      },
      { id: "evt_sparse00000000000000", seq: 1, type: "session.updated.1", data: "{}" },
    ])
  })
})

// TKT-318: closes the gap the block above's comment names -- baseline.db (TKT-308) had no
// genuinely-superseded decoder to fixture against because nothing had bumped a durable event
// version past .1 yet. Compaction.Ended is now the first. A NEW file, per the corpus's
// immutable-input rule -- baseline.db is merged and untouched.
const compactionVersioningPath = fileURLToPath(
  new URL("../../../fixtures/regression-corpus/db/compaction-versioned-events.db", import.meta.url),
)

describe("regression corpus: db/compaction-versioned-events.db", () => {
  test("both a version-1 and a version-2 Compaction.Ended row decode through the real event service", async () => {
    await using tmp = await tmpdir()
    const copyPath = path.join(tmp.path, "compaction-versioning-copy.db")
    await fs.copyFile(compactionVersioningPath, copyPath)

    const decoded = await Effect.runPromise(
      Effect.gen(function* () {
        yield* DatabaseMigration.apply((yield* Database.Service).db)
        const events = yield* EventV2.Service
        return yield* events
          .durable({ aggregateID: "ses_compacted_twice00000" })
          .pipe(Stream.take(2), Stream.runCollect)
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node]), [
            [Database.node, Database.layerFromPath(copyPath)],
          ]),
        ),
        Effect.scoped,
      ),
    )

    const rows = Array.from(decoded)
    expect(rows).toHaveLength(2)

    expect(rows[0]?.type).toBe("session.next.compaction.ended")
    expect(rows[0]?.durable?.version).toBe(1)
    const v1 = rows[0]?.data as { text: string; tokensBefore?: number }
    expect(v1.text).toContain("Pre-upgrade")
    expect(v1.tokensBefore).toBeUndefined()

    expect(rows[1]?.type).toBe("session.next.compaction.ended")
    expect(rows[1]?.durable?.version).toBe(2)
    const v2 = rows[1]?.data as { text: string; tokensBefore?: number; durationMs?: number }
    expect(v2.text).toContain("Post-upgrade")
    expect(v2.tokensBefore).toBe(12_000)
    expect(v2.durationMs).toBe(4200)
  })
})
