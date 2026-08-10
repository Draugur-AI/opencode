# Regression corpus

Immutable input fixtures for the OpenCode reliability redesign, per the validation post's
["Preserve a behavioral baseline before replacing paths"](https://drafts.draugur.ai/2026-08-10-validating-the-opencode-reliability-redesign.html#preserve-a-behavioral-baseline-before-replacing-paths)
section. Each subdirectory is one fixture class from that section.

## The rule: these are immutable inputs

**When a migration or behavior change legitimately produces a different output for a fixture
here, add a NEW file recording the new expected form. Never edit or delete an existing fixture
file.** The value of this corpus is being able to run every historical fixture through every
future binary and see what changed — that comparison is destroyed the moment a "fix" is applied
by editing the input instead of adding beside it.

If a fixture turns out to be wrong (a typo, an invalid value that doesn't match the real schema),
that's a bug in this PR's authoring and can be corrected before merge. Once merged, treat every
file here as append-only.

## Fixture classes

- **`db/`** — SQLite database fixtures. `build.ts` is the deterministic builder (run it from
  `packages/core`: `bun run script/build-regression-fixtures.ts` — it lives there because it
  needs Core's internal `DatabaseMigration`/`Database` modules, not under `fixtures/` where those
  workspace imports don't resolve). `baseline.db` is the committed output: a current-format
  project, a legacy-format project (bare root-commit-sha ID), an active session, an archived
  session, a legacy session with an empty `directory` (a documented-valid legacy value —
  `packages/core/src/database/path.ts`), V1 `message`/`part` rows including one sparse
  `data: '{}'` malformed-but-readable historical row, V2 `session_message` rows (user, assistant
  with a completed tool call, and an auto compaction), and a two-row durable event log
  (`event`/`event_sequence`) on the active session: a normal `session.created.1` event, then a
  `session.updated.1` event with a sparse `data: '{}'` payload — the old-event-decoder case,
  proving a versioned event an older emitter wrote before a field existed still loads.

  `compaction-versioned-events.db` (TKT-318, `build-regression-fixtures-compaction-versioning.ts`)
  closes the gap this section used to name here as open: the first *genuinely-superseded* decoder
  in this fork. `Compaction.Ended` was bumped from durable version 1 to version 2 (telemetry
  fields added) when `session/compaction.ts` gained trigger/token/timing telemetry; the old
  version-1 definition (`Compaction.EndedV1` in `packages/schema/src/session-event.ts`) is kept
  purely for decode, never republished. The fixture is one session compacted twice — once by a
  pre-slice-5 binary (version 1, no telemetry) and once by the current one (version 2, full
  telemetry) — exactly what a session that lived across the upgrade would contain. Both rows must
  decode through the real event service; see `packages/core/test/session-compaction-versioning.test.ts`
  for the live-decode proof this fixture freezes.

  Both files loaded and asserted against by `packages/core/test/fixture-corpus.test.ts`.

- **`protocol/`** — JSON fixtures for the current (V2) and compatibility (V1) session wire
  shapes: `session-get.v2.json` and `session-list.v2.json` match
  `packages/protocol/src/groups/session.ts`'s `session.get`/`session.list` success schemas
  exactly (envelope, field names, `Session.Info` shape). `session-info.v1-compat.json` matches
  the V1 session-info object literal verified against
  `packages/core/test/database-migration.test.ts` (`SessionV1.Event.Updated`'s `info` payload) —
  there is no separately-exported `SessionV1.Info` schema in the reviewed snapshot, so this
  fixture's provenance is that test, not a schema file.

- **`browser-state/`** — `tabs.json` is a real `Tab[]` (packages/app/src/context/tabs.tsx)
  persisted-localStorage fixture; `server-snapshot.json` is what the server actually holds for
  those session IDs. The persisted `Tab` carries no status field — reconciling the two files is
  what produces the five outcome categories the validation post asks for (valid, archived, stale
  i.e. purged-with-tombstone, missing, unavailable-server); see `server-snapshot.json`'s
  `expectedReconciliation` for the intended result per tab.

- **`transcripts/`** — `mcp-permission-retry-compaction.json` is a `session_message` sequence
  exercising tool output, an MCP tool call, a permission denial, a retry, plugin-hook metadata,
  and compaction. Read its `_caveats` field before relying on it: retry and plugin-hook are not
  first-class message types in the reviewed `0bff28de` schema (no Monitor/hooks subsystem exists
  yet), so they're represented via the `metadata` field using the build post's `pluginID/hookName`
  key convention rather than a real event shape. Treat those two specifically as illustrative,
  not as a contract.

## Regenerating a `db/` fixture

Only ever needed if a fixture was built wrong before merge — see "The rule" above for what to do
after merge. Each fixture file has its own builder script:

```bash
cd packages/core
bun run script/build-regression-fixtures.ts                          # db/baseline.db
bun run script/build-regression-fixtures-compaction-versioning.ts    # db/compaction-versioned-events.db
```

Both builders are deterministic (fixed timestamps, fixed IDs), so a correct re-run produces a
byte-identical file.
