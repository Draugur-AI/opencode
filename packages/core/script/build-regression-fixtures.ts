#!/usr/bin/env bun
/**
 * Regenerates fixtures/regression-corpus/db/baseline.db.
 *
 * Run from packages/core: `bun run script/build-regression-fixtures.ts`
 * (lives here, not under fixtures/, because it needs the workspace deps that
 * are only resolvable from inside this package — see packages/core/script/migration.ts
 * for the same convention).
 *
 * This builds a fresh SQLite file via the real DatabaseMigration.apply() path
 * (packages/core/src/database/migration.ts) so the schema is byte-identical to
 * what a running instance would create, then inserts hand-authored rows for
 * every fixture class the regression corpus needs. It intentionally uses raw
 * INSERT statements (the pattern packages/core/test/database-migration.test.ts
 * already uses for cross-version fixtures) rather than the Effect service
 * layer, because some rows here — the legacy project ID, the empty-directory
 * session — are deliberately *not* what current code would ever write.
 *
 * baseline.db is a committed, immutable input (see ../../../fixtures/regression-corpus/README.md).
 * If a future
 * migration legitimately needs a new row shape, add a NEW fixture file next
 * to this one — do not edit baseline.db's existing rows in place.
 */
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { existsSync, unlinkSync } from "fs"
import { fileURLToPath } from "url"

const outPath = fileURLToPath(new URL("../../../fixtures/regression-corpus/db/baseline.db", import.meta.url))
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

    // -- Current-format project: git-remote-derived ID, current worktree layout.
    yield* db.run(sql`
      INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes)
      VALUES ('git-remote:github.com/draugur-ai/opencode', '/home/user/opencode', 'git', 'opencode',
              ${T0}, ${T0}, '[]')
    `)

    // -- Legacy-format project: bare root-commit-sha ID, the pre-remote-hash scheme
    //    (packages/core/src/project.ts resolve() root() fallback).
    yield* db.run(sql`
      INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes)
      VALUES ('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', '/home/user/legacy-repo', 'git', NULL,
              ${T0}, ${T0}, '[]')
    `)

    // -- Active session under the current-format project.
    yield* db.run(sql`
      INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
      VALUES ('ses_active0000000000000000', 'git-remote:github.com/draugur-ai/opencode', 'active-session',
              '/home/user/opencode', 'Fix the login bug', 'fixture', ${T0}, ${T0 + 60_000})
    `)

    // -- Archived session under the same project (time_archived set).
    yield* db.run(sql`
      INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, time_archived)
      VALUES ('ses_archived000000000000', 'git-remote:github.com/draugur-ai/opencode', 'archived-session',
              '/home/user/opencode', 'Old refactor spike', 'fixture', ${T0}, ${T0 + 120_000}, ${T0 + 200_000})
    `)

    // -- Legacy session under the legacy project: empty `directory` is a documented-valid
    //    legacy value (packages/core/src/database/path.ts: "Legacy sessions may persist an
    //    empty directory. Keep that existing value readable...").
    yield* db.run(sql`
      INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
      VALUES ('ses_legacydir00000000000', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', 'legacy-session',
              '', 'Pre-worktree-tracking session', 'fixture-legacy', ${T0}, ${T0})
    `)

    // -- Durable event log on the active session: a normal current-version event, then an
    //    old-event-decoder case. This snapshot (0bff28de-derived dev) has never bumped a
    //    versioned event type past ".1" (checked: no ".2"+ type exists anywhere in the repo),
    //    so there is no genuinely-superseded decoder to fixture against yet. What *is*
    //    real and already relied on elsewhere (packages/core/test/database-migration.test.ts,
    //    "preserves canonical V1 state and restarts its event stream") is a versioned event
    //    row with a sparse `data: '{}'` payload -- an event older emitters wrote before a
    //    field was added, which the current decoder must still load without dying. That's
    //    the malformed-but-readable property this fixture proves; see README for the
    //    superseded-version gap this leaves open.
    yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('ses_active0000000000000000', 1)`)
    yield* db.run(sql`
      INSERT INTO event (id, aggregate_id, seq, type, data)
      VALUES ('evt_created0000000000000', 'ses_active0000000000000000', 0, 'session.created.1', ${JSON.stringify({
        sessionID: "ses_active0000000000000000",
        info: { title: "Fix the login bug" },
      })})
    `)
    yield* db.run(sql`
      INSERT INTO event (id, aggregate_id, seq, type, data)
      VALUES ('evt_sparse00000000000000', 'ses_active0000000000000000', 1, 'session.updated.1', '{}')
    `)

    // -- V1 message/part rows on the active session: a user message and an assistant
    //    message with a completed tool call, matching the shapes packages/schema/src/v1/session.ts
    //    decodes (SessionV1.Info is a User|Assistant union; Part includes ToolPart).
    yield* db.run(sql`
      INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES ('msg_v1user0000000000000000', 'ses_active0000000000000000', ${T0}, ${T0}, ${JSON.stringify({
        role: "user",
      })})
    `)
    yield* db.run(sql`
      INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
      VALUES ('prt_v1text0000000000000000', 'msg_v1user0000000000000000', 'ses_active0000000000000000',
              ${T0}, ${T0}, ${JSON.stringify({ type: "text", text: "The login page 500s on a bad password." })})
    `)
    yield* db.run(sql`
      INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES ('msg_v1asst0000000000000000', 'ses_active0000000000000000', ${T0 + 1000}, ${T0 + 5000}, ${JSON.stringify(
        { role: "assistant" },
      )})
    `)
    yield* db.run(sql`
      INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
      VALUES ('prt_v1tool0000000000000000', 'msg_v1asst0000000000000000', 'ses_active0000000000000000',
              ${T0 + 1000}, ${T0 + 5000}, ${JSON.stringify({
        type: "tool",
        tool: "grep",
        state: { status: "completed", input: { pattern: "500" }, output: "auth.ts:42", metadata: {} },
      })})
    `)

    // -- Malformed-but-readable historical record: sparse `data: '{}'`, the same shape
    //    packages/core/test/database-migration.test.ts uses for a pre-migration row that
    //    must still decode (or at least load) without the migration runner dying.
    yield* db.run(sql`
      INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES ('msg_v1sparse00000000000000', 'ses_legacydir00000000000', ${T0}, ${T0}, '{}')
    `)
    yield* db.run(sql`
      INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
      VALUES ('prt_v1sparse00000000000000', 'msg_v1sparse00000000000000', 'ses_legacydir00000000000',
              ${T0}, ${T0}, '{}')
    `)

    // -- V2 session_message projections on the active session: user, assistant with a
    //    completed tool call, then an auto compaction summarizing both.
    yield* db.run(sql`
      INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
      VALUES ('msg_v2user0000000000000000', 'ses_active0000000000000000', 'user', 0, ${T0}, ${T0}, ${JSON.stringify({
        text: "The login page 500s on a bad password.",
        files: [],
        agents: [],
      })})
    `)
    yield* db.run(sql`
      INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
      VALUES ('msg_v2asst0000000000000000', 'ses_active0000000000000000', 'assistant', 1, ${T0 + 1000}, ${
        T0 + 5000
      }, ${JSON.stringify({
        agent: "build",
        model: { id: "claude-sonnet-5", providerID: "anthropic" },
        content: [
          {
            type: "tool",
            id: "tool_1",
            name: "grep",
            state: {
              status: "completed",
              input: { pattern: "500" },
              content: [{ type: "text", text: "auth.ts:42" }],
              structured: {},
            },
            time: { created: T0 + 1000, ran: T0 + 1200, completed: T0 + 1400 },
          },
        ],
        tokens: { input: 120, output: 40, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0.002,
        time: { created: T0 + 1000, completed: T0 + 5000 },
      })})
    `)
    yield* db.run(sql`
      INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
      VALUES ('msg_v2compact000000000000', 'ses_active0000000000000000', 'compaction', 2, ${T0 + 6000}, ${
        T0 + 6000
      }, ${JSON.stringify({
        reason: "auto",
        summary: "User reported a 500 on bad-password login. Assistant found auth.ts:42 as the likely site.",
        recent: "",
      })})
    `)

    console.log(`wrote ${outPath}`)
  }).pipe(Effect.provide(SqliteClient.layer({ filename: outPath, disableWAL: true })), Effect.scoped),
)
