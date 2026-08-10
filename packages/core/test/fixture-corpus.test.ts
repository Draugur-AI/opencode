import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { Effect } from "effect"
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
        const compaction = yield* db.get<{ data: string }>(
          sql`SELECT data FROM session_message WHERE type = 'compaction' LIMIT 1`,
        )

        return { projects, sessions, v1MessageCount, v1PartCount, v2ByType, compaction }
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
  })
})
