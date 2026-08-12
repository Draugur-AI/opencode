# FORK.md — Draugur-AI/opencode

## What this fork is

`Draugur-AI/opencode` is a fork of [`anomalyco/opencode`](https://github.com/anomalyco/opencode)
carrying the **OpenCode reliability redesign**: one authoritative model for projects and session
lifecycle, and one durable model for what an agent is trying to achieve, replacing a set of
disconnected browser-side workarounds. The redesign is specified in three posts, all reviewed
against upstream `dev` at commit
[`0bff28de`](https://github.com/anomalyco/opencode/commit/0bff28de09105088ff5bdefab91413d55c28dff1)
on 2026-08-10. That commit is a permanent spec anchor: the posts' file/line citations and the
recorded build/test baseline stay pinned to it and are never re-anchored. The fork's **sync
base** — the point its `dev` has merged upstream through — is a separate, moving thing; it
advances weekly under the sync policy below and is tracked by the sync PRs themselves, not by
this file.

- [Making OpenCode dependable for long-running work](https://drafts.draugur.ai/2026-08-10-making-opencode-dependable-for-long-running-work.html) — the product design
- [Building the OpenCode reliability redesign](https://drafts.draugur.ai/2026-08-10-building-the-opencode-reliability-redesign.html) — the schema/service/protocol map
- [Validating the OpenCode reliability redesign without regressions](https://drafts.draugur.ai/2026-08-10-validating-the-opencode-reliability-redesign.html) — the test and rollout plan

A change that is not traceable to one of these three posts, or to keeping the fork buildable and
in sync with upstream, does not belong here. This file states the policy that keeps the fork
mergeable back into a fast-moving upstream instead of drifting into an unmaintainable rewrite.

## Upstream-sync policy

- **Cadence:** merge upstream `dev` into this fork's `dev` **weekly**. Do not wait until the
  redesign, or any milestone of it, is complete — the build post is explicit that upstream
  drift, not implementation difficulty, is the dominant long-term cost of a fork left to diverge.
- **Budget:** a sync that costs more than **one engineer-day** to resolve is over budget. The
  lead (`Ethan`, or whoever holds that role at sync time) can adjust the budget for a specific
  sync in advance, but the default is one engineer-day and no sync silently gets more than that.
- **Measure it:** record start time, end time, and conflicted-file count for every sync in the
  divergence ledger below or in the syncing PR's description. This is what "exceeds the budget"
  is checked against — not a feeling.
- **On exceeding budget:** pause new feature work and open a ticket (or comment on the existing
  sync ticket) naming which files conflicted and why. Resolving upstream drift takes priority
  over the next redesign slice until the sync lands.
- **How to keep syncs cheap:** every fork-only change follows the PR conventions below. A sync
  that is expensive because of our own formatting or renaming churn is a self-inflicted cost, not
  evidence upstream moved unusually fast.

## Divergence ledger

Every intentional divergence from upstream — anything upstream would not accept as-is, or that we
are deliberately holding back from proposing — gets a row here at the time it merges. This table
is the fork's memory: a later agent should be able to tell what is fork-only, why, and what
retires it without reading every PR.

| Change | Why | Upstream issue/PR | Schema impact | Migration impact | Resolution |
| --- | --- | --- | --- | --- | --- |
| `.github/workflows/typecheck.yml`: `runs-on: blacksmith-4vcpu-ubuntu-2404` → `ubuntu-latest` | Blacksmith is a hosted-runner service gated by a GitHub App install; `Draugur-AI` does not have it installed, so jobs targeting `blacksmith-*` labels queue forever and never report (confirmed empirically: 15+ min, never left `queued`). See "CI runner reality" below. | none — fork-infra only, upstream's own CI intentionally uses Blacksmith | none | none | **keep** — no Blacksmith app on this org, and GitHub-hosted is the deliberate long-term choice (avoids coupling this repo to infra it doesn't own) |
| `.github/workflows/test.yml`: `unit` job matrix, both `host:` entries (`blacksmith-4vcpu-ubuntu-2404` / `blacksmith-4vcpu-windows-2025`) → `ubuntu-latest` / `windows-latest` | Same reason. This job also runs `check:generated` and `test:httpapi` (Linux-only steps within it), so fixing it alone covers typecheck + per-package tests + generated-client check. | none — fork-infra only | none | none | **keep** — no Blacksmith app on this org |
| Session lifecycle domain: `Lifecycle` union + `lifecycleRevision` on `Session.Info`, durable `SessionEvent.LifecycleChanged`, explicit archive/restore/trash/restore-from-trash/purge verbs, tombstones, request deduplication, purge worker ([#4](https://github.com/Draugur-AI/opencode/pull/4)) | Upstream has an archived timestamp but no lifecycle type, grace period or revision, so restore, trash, purge, stale writes and deterministic client reconciliation cannot be expressed at all. Design post, "Fix session lifecycle before session chrome" | not yet filed | Adds `lifecycle`, `lifecycle_revision`, `time_trashed`, `purge_after`, `trash_restore_to` to `session`; adds `session_tombstone` and `session_lifecycle_request`; adds index `(project_id, lifecycle, time_updated, id)`. New durable event type, additive — no existing decoder changed | `20260810124427_session_lifecycle`: additive DDL plus a backfill setting `lifecycle = 'archived'` where `time_archived` is present. Idempotent — tested applied twice with a row written in between | **upstream** — this domain is what we would propose back; file the upstream issue before the first sync that touches it |
| V1 compatibility shim: `time_archived` retained as a mirror of `lifecycle === 'archived'`, and `PATCH /session/:id { time: { archived } }` rewritten as an adapter over the lifecycle service ([#4](https://github.com/Draugur-AI/opencode/pull/4)) | Old clients must keep working through the migration window, and two paths writing the same state independently is how they drift apart — so the old route translates rather than writing the column itself. Validation post, "Compatibility is a differential test" | n/a — shim, not proposed upstream | `session.time_archived` kept beyond its usefulness to the current domain | none beyond the row above | **remove** — delete the column and the V1 route together once telemetry shows the V1 archive path unused for a full release window. Known limit until then: a **trashed** session still appears in a V1 active list, because V1 filters on `time_archived` and has no representation for trash; it disappears from V1 on purge. Revisit when slice 2 ships the Trash UI |
| Durable agent intent: `SessionGoal`/`SessionLedger` domains — `Goal.Updated`/`Goal.StatusChanged`/`Ledger.Added`/`Ledger.Superseded` events, `session_goal`/`session_ledger` tables, session-scoped `GoalContext`/`LedgerContext` composed directly in the runner alongside skill/reference guidance, `goal_get`/`goal_update_progress`/`ledger_add` tools, `session.goal`/`session.ledger` route groups ([#7](https://github.com/Draugur-AI/opencode/pull/7)) | Upstream has no durable goal or working-ledger concept at all, so a long session's binding objective and accumulated decisions exist only as prose the compaction summary may or may not preserve. Design post, "Durable agent intent must survive compaction"; build post, "Durable intent: goal, ledger, context, and recovery" | not yet filed | Adds `session_goal` (one row per session, atomic-replace) and `session_ledger` (append-only, superseded not deleted) with FK cascade to `session`; four new durable event types, additive — no existing decoder changed | `20260810151354_session_goal_ledger`: additive DDL only, no backfill (no prior rows to migrate). Idempotent by construction | **upstream** — this domain is exactly what the design/build posts argue upstream needs; file the issue before the first sync that touches session context assembly |
| History search & compaction telemetry: `session_transcript_search` FTS5 projection kept in sync by the projector, `history_search`/`history_get` tools, `session.history.search`/`.get` routes; `SessionEvent.Compaction.Ended` versioned to durable v2 (per-compaction telemetry) with `EndedV1` kept as a superseded decoder for old rows — the first event in this fork to keep an old decoder alongside its successor rather than deleting it ([#10](https://github.com/Draugur-AI/opencode/pull/10)) | Upstream has no full-history search surface and no compaction telemetry, so an identifier a compaction summary drops is unrecoverable and a compaction's cost/effect is invisible. Design post, "Full-history search" and "Compaction telemetry"; build post, "versioned successor, old decoder kept" | not yet filed | Adds `session_transcript_search` (FTS5, no FK — deleted explicitly in `purge.ts`); `Compaction.Ended` gains 8 telemetry fields (additive, v2), `EndedV1` is the kept v1 decoder (durable-only, never in the general event union). `Event.define` gained an optional `identifier` param — the versioned-successor pattern is the first case where two definitions share one `type` literal, which without a distinct OpenAPI identifier collided into duplicate generated schemas; `packages/sdk/js/script/build.ts`'s dedup pass was generalized from a single known-unreachable-name check to a structural (byte-equality) fixed-point pass to collapse them | `20260810170000_session_transcript_search`: additive FTS5 virtual table, no backfill. Also closed a fresh-DB migration gap for any hand-written (non-drizzle) schema object via `HAND_MAINTAINED_SCHEMA_ADDITIONS` in `migration.ts` | **upstream** — history search and compaction telemetry are exactly what the design/build posts argue upstream needs; file the issue before the first sync that touches compaction or session event versioning |
| Context-retention evaluation harness: new `@opencode-ai/eval` package — a scripted-model V2 app-graph builder, a per-instance fake `LLMClient.Service` capturing every composed `LLMRequest`, injected/real compaction epoch drivers, restart-survival via `Database.layerFromPath` reopen, per-source token/byte accounting, and two fixtures (omitted-identifier-recovery, constraint-survival) run in both real and pre-slice-4-approximation (`Layer.mock` on `SessionGoal`/`SessionLedger.context()`) modes, with a `bun run gate` CLI report ([#12](https://github.com/Draugur-AI/opencode/pull/12), PR1 of 3). PR2 ([#17](https://github.com/Draugur-AI/opencode/pull/17)) adds the baseline arm: the same two fixtures driven over real HTTP against the real pre-slice-4 binary (pinned sha, built+cached via a throwaway worktree) run as a real subprocess, plus a minimal fake OpenAI-compatible HTTP LLM server that binary's own provider config points at — both arms' fixtures import scenario inputs from one `scenarios/` module so they cannot drift on what was asked. PR3 (not yet filed) adds real qwen3-6/LiteLLM wiring for both arms (`buildReal` alongside each arm's scripted `build`, gated behind `OPENCODE_EVAL_REAL=1` since a real-model dependency must never be in merge-gate CI) and TKT-319's first real findings: the current arm's history_search tool is genuinely offered but not always reached for unprompted (feedback #162, product work); the baseline arm's real pre-slice-4 binary hangs 300s+ on its first turn against a reasoning model and is `test.skip`'d with the observed evidence rather than chased, since patching the old binary would contaminate the control arm (feedback #163, a deferred environment-shim option). R=5/concurrency=8 repeats, cassettes and a dedicated report module were scoped out (Ethan's ruling) — the ticket's gate report is written from what PR1-3 already prove, not built as further infrastructure. | Upstream has no outcome-evaluation harness for compaction reliability at all, and the design/validation posts are explicit that schema/service tests passing is not evidence the agent actually retains anything — "score decisions, not summary resemblance." Design post, "Context-retention evaluation"; validation post, "Agent reliability requires outcome evaluations" | not yet filed | none — pure new tooling package, no schema/table changes | none | **keep** — this harness is fork-specific by construction (it tests `SessionGoal`/`SessionLedger`/history-search, none of which exist upstream); it stays fork-only even if the domains it tests eventually get proposed upstream |
| Normalized app session entities + tab reconciliation: `session-entities.ts` reducer keyed by (server scope, session ID), `SessionEntitiesProvider`, and `TabsProvider.reconcile()` ([#11](https://github.com/Draugur-AI/opencode/pull/11)) | Upstream keeps three independent session truths in the browser — a sorted array merged by ID in `global-sync/bootstrap.ts`, tab references validated against known *servers* rather than known *sessions*, and a browser-only `opencode:session-tabs-removed` custom event. Races between them are structural, not incidental: an archived session can flash back on an SSE race. Design post, "Fix session lifecycle before session chrome" | not yet filed | none — client-side projection only; types are imported from `@opencode-ai/schema`, the package the generated client is produced from | none | **upstream** — the client half of the lifecycle domain, proposed back with it |
| App "Delete…" session action rewired from the legacy `DELETE /session/:id` route (`sdk().api.session.remove`, a permanent, non-recoverable hard delete) to the `trash` lifecycle route (`session-lifecycle-client.ts`'s `client.trash(...)`), in `packages/app/src/pages/session/timeline/message-timeline.tsx` (TKT-349) | Found by the day-two runbook walk: clicking Delete… on an active session made it permanently, unrecoverably gone instead of trash-with-grace-period, the app's own stated promise. Root cause: the app called the legacy V1 remove route directly rather than any lifecycle route at all. This row is the app-side half of the fix — it is independent of, and does not depend on, the V1 `session.remove` adapter (deferred, see the section above); the legacy route itself still exists and still hard-deletes for its remaining CLI/ACP/teardown callers | n/a — bug fix, not a divergence pattern | none | none | **remove** — once the deferred V1 `session.remove` adapter lands with its own designed dependency shape, this row's "the legacy route still hard-deletes" caveat should be re-verified and this row closed alongside it |
| Temporary `@opencode-ai/client-next` alias in `packages/app`, reaching the workspace client for **six** session-lifecycle calls: four mutations (`restore`, `trash`, `restoreFromTrash`, `purge`) plus `list` (lifecycle-aware, index-summary shape) and `get` (TKT-314, session-entities feed) ([#11](https://github.com/Draugur-AI/opencode/pull/11)) | `packages/app` pins `@opencode-ai/client` to a vendored tarball generated before session lifecycle existed, so those routes are absent from it — including a lifecycle-filterable list, which the normalized entity store's snapshot feed needs (`lifecycle: "all"`) and the vendored client cannot express at all. Archive is deliberately NOT on the alias: it still goes through the V1 route, which the slice-1 server adapter drives into the same lifecycle service. Migrating the app off the vendored client is 42 files and its own ticket | n/a — fork-only packaging workaround | none | none | **remove** — deleted together with the vendored tarball by **TKT-328** (app + session-ui onto one client, amended to cover all four importers below). Bounded by construction: `packages/app/src/utils/session-lifecycle-client.ts` is this alias's only importer for session-lifecycle calls and says so in its header — see the next three rows for the project-calls, goal/ledger-calls, and mcp-catalog-calls siblings, each added by ruling rather than by drift. **Four** importers total as of the Integrations page's 2026-08-12 re-scope (was three, was two before TKT-328's 2026-08-11 re-scope); none may accrete further without another re-scope |
| Second `@opencode-ai/client-next` importer, `packages/app/src/utils/project-client.ts`, reaching the workspace client for **five** project calls (`list`, `get`, `updateMetadata`, preference `read`, preference `write`) (TKT-315) | Same vendored-tarball gap as the row above, for project data instead of session lifecycle: the vendored client predates PR #8's project/preference endpoints entirely, so TKT-315's app half (favorites that persist server-side — the entire point of "two browsers converge on the same favorites") cannot be built against it. Ruled rather than assumed: extending `session-lifecycle-client.ts` itself was rejected because that file is Henry's, under active use by his views work, and editing it mid-flight would manufacture the exact collision the one-importer discipline exists to prevent. A second, equally narrow, equally bounded file was the correct shape instead of either widening the first file or blocking the ticket on a vendored client with no preference support at all | n/a — fork-only packaging workaround | none | none | **remove** — deleted together with the vendored tarball and the row above by **TKT-328**, now covering all three importers by amendment. Bounded by construction, same discipline as the row above: `project-client.ts` is this half's only importer and says so in its own header |
| Third `@opencode-ai/client-next` importer, `packages/app/src/utils/goal-ledger-client.ts`, reaching the workspace client for **six** session goal/ledger calls: `serverGoal.get`/`update`/`status` plus `serverLedger.list`/`add`/`supersede` (TKT-335) | Same vendored-tarball gap as the two rows above, for the durable session goal and working ledger (TKT-317, design post "Durable agent intent must survive compaction") instead of session lifecycle or project data: the vendored client predates PR #7's goal/ledger routes entirely, so TKT-335's goal side panel and ledger panel (objective, acceptance criteria, constraints, supersede) cannot be built against it. Re-scoped rather than assumed: TKT-328 was originally bounded to two importers ("neither accretes further"); the lead re-scoped it 2026-08-11 after a mechanical-migration attempt measured 534 semantic type errors, explicitly admitting a third bounded importer as part of TKT-328's own interim state rather than blocking TKT-335 on a vendored client with no goal/ledger support at all | n/a — fork-only packaging workaround | none | none | **remove** — deleted together with the vendored tarball and the two rows above by **TKT-328**. Bounded by construction, same discipline as the rows above: `goal-ledger-client.ts` is this half's only importer and says so in its own header |
| Fourth `@opencode-ai/client-next` importer, `packages/app/src/utils/mcp-catalog-client.ts`, reaching the workspace client for **two** calls: `mcp.list` (static catalog) and `mcp.status` (live per-server connection status) (TKT-323 chunk 3) | Re-scoped, not assumed: the Integrations page cannot exist on either other client — the vendored tarball's `mcp.list` is a stale, differently-shaped `McpServer` type (a `pending` status this domain's union does not have) with no `status` method at all, and `@opencode-ai/sdk` v2 (`useServerSDK()`) only has the legacy `/mcp` surface, no `/api/mcp` or `/api/mcp/status` — so this page exists via client-next or not at all | n/a — fork-only packaging workaround | none | none | **remove** — deleted together with the vendored tarball and the three rows above by **TKT-328**. Bounded by construction, same discipline as the rows above: `mcp-catalog-client.ts` is this half's only importer and says so in its own header |
| Session profiles: `Profile.Definition`/`Profile.Snapshot` schemas, immutable `session_profile_snapshot` table + `session.profile_snapshot_id`, `SessionEvent.ProfileSwitched` (event-sourced, carries the full resolved snapshot so the projector needs no second read), `SessionProfile` core service (`resolve`/`get`/`context`/`toolDenyRuleset`), `PermissionV2.configured` merging a profile's deny-only ruleset into every leaf `assert`/`ask` call, `ToolRegistry.materialize` widened from `materialize(permissions)` to `materialize({permissions, profileToolRules})`, `SkillGuidance.load` widened with an optional `skillRules` filter, built-in `coding`/`chat` definitions (core code constants, not DB rows), and a contained V1 hook-identity refactor (`packages/opencode/src/plugin/index.ts`'s flat `Hooks[]` → `LoadedHooks{pluginID, origin, hooks}[]`) (TKT-321) | Upstream has no durable per-session policy overlay at all — a "chat vs. coding" toggle would have to hide UI without touching what the model can actually invoke, exactly the "profiles produce security theater" risk the validation post names. Design post, "Session profiles solve chat versus coding behavior"; build post, "Profiles: persist behavior, not just a label" | not yet filed | Adds `session_profile_snapshot` (append-only, FK cascade to `session`) and a nullable `session.profile_snapshot_id`; one new durable event type, additive. `MaterializeRequest`/`SkillGuidance.load`'s new param are both additive/optional — no existing caller signature became invalid without a corresponding call-site fix in the same PR | `20260811182549_session_profile_snapshot`: additive DDL only, no backfill (pre-migration sessions simply read as "no profile resolved yet," per `SessionProfile.get`'s documented undefined case) | **upstream** for the schema/policy/skill-filtering half — exactly what the design/build posts argue upstream needs. **Deferred, not upstream, not fork-only**: (1) resolve-on-session-create wiring (a session does not yet get a profile automatically; the demo test in `test/permission.test.ts` resolves one explicitly), (2) MCP tool materialization filtering (`mcpRules` exists in the schema, but `packages/core/src/tool` has no MCP tool registration path to filter yet — the comment in `tool/builtins.ts` says as much), (3) the app-side composer UI (current profile display, switch diff) — coordinate-with-Henry per the ticket, not attempted this PR, (4) threading `TriggerContext` (sessionID + resolved profile) through `Plugin.Service.trigger` for session-aware hook filtering — `trigger()` has 20+ call sites across `packages/opencode/src`, too large a blast radius for this PR; `LoadedHooks` preserves the identity a follow-up needs without touching any of them |
| Config document writer, chunk 1: `packages/core/src/config/document.ts` (`listTargets`/`readTarget`/`effective`-with-provenance/`validatePatch`/`applyPatch`, allowlisted typed `Patch` union, atomic temp-file-then-rename write, sha256 optimistic hash check, opaque server-derived `TargetID` — never a browser-supplied path), `McpCatalog` core read model (declared servers only), two new Protocol groups (`config-document`: generic patch-apply surface every future catalog reuses; `mcp`: read-only `mcp.list`), wire types relocated `packages/core/src/config/mcp.ts` → `packages/schema/src/config-mcp.ts` (protocol cannot depend on core; core now re-exports, same pattern as Integration/SessionProfile) plus two new schema modules (`config-document.ts`, `mcp-catalog.ts`) (TKT-323) | Upstream has no editable-config surface at all — `Config.Info` is read-oriented and merges global/project silently; a settings UI serializing the merged result back to one file would destroy comments, provenance, and overrides. Build post, "Configuration UI: edit a source document, never the merged result" | not yet filed | No table changes — config lives in files, not the DB. Two new durable-free schema modules (config-document.ts, mcp-catalog.ts); `ConfigMCP.Server`/`Local`/`Remote`/`OAuth`/`Timeout` moved from core to schema, core re-exports — no consumer signature changed | none | **upstream** for `document.ts`'s patch-apply model and the config-document/mcp protocol groups — exactly the "edit a source document" pattern the build post argues for. **Deferred, not upstream, not fork-only**: live MCP connection/tool/resource status (`McpCatalog.Status` is `"configured"\|"disabled"` only — no core service can reach the live runtime in `packages/opencode/src/mcp/index.ts` yet; chunk 2 adds a core `McpRuntime` service TAG with the live implementation supplied as a layer at `packages/opencode`'s httpapi-assembly time, preserving the dependency direction rather than relocating the runtime), skills/plugins/profiles catalogs and their settings-v2 UI routes (chunks 2-3), `.opencode`-directory supplementary files are not yet listed as patchable targets (MCP servers live in the top-level file only) |

| Command Monitor, PR1 of the slice (declaration + recovery, no execution): `packages/schema/src/monitor.ts` + `monitor-event.ts` (`Monitor.Info`, 7 session-owned durable events registered into `durable-event-manifest.ts`/`event-manifest.ts`), `packages/core/src/monitor/sql.ts` (`monitor` table only — see Schema impact), `packages/core/src/monitor.ts` (`create`/`list`/`get`/`recover`, event-sourced through the existing `session/projector.ts` global projector alongside `SessionGoal`/`SessionLedger`; row `revision` is server-assigned from `event.durable.seq + 1` at project time, same as `SessionGoal.projectUpdated`) (TKT-322) | Upstream's `BackgroundJob` explicitly disclaims restart survival, and `tool/bash.ts:70-77` lists durable status, restart recovery and owned observation as its own future work in that exact order — Monitor needs its own durable domain rather than an HTTP wrapper around `BackgroundJob`. Design post, "Monitor: durable declaration, process-owned execution"; design note diary 2435 (upstream-TODO acceptance bar), addendum 2437 (tombstone ruling), diary 2530 (layer-graph deltas, authoritative on conflict with 2435) | not yet filed | Adds `monitor` (FK cascade to `session`; indexed on `session_id` for per-session lookups and, separately, on `status` alone — `recover()` scans process-wide with no `session_id` predicate, so a composite leading with `session_id` could not serve it, leftmost-column rule; Copilot review caught the first-cut composite index actually missing that query); 7 new durable event types, additive. `MonitorEvent.Created` carries `info: Monitor.Info` without a sibling top-level `monitorID` (dropped after Copilot + Ethan independently flagged the same redundancy: a durable event could otherwise validate and persist with `monitorID !== info.id`) — `sessionID` stays at top level since the aggregate router reads `data.sessionID` by field name and cannot reach into `info`. `monitor_check` (bounded per-check records) is deliberately **not** added yet — nothing writes to it until `monitor/condition.ts`/`monitor/output.ts` exist, so declaring it now would be a table with no writer. No tombstone: diary 2437 rules a monitor declaration's `source` can carry a command string, content by any reading, so purge removes the row entirely rather than retaining an identifier-only tombstone (`session-purge.test.ts`'s inventory: `monitor: "purged"`) | `20260812055027_monitor`: additive DDL only, no backfill. Generated via `bun script/migration.ts --name monitor`, `--check` clean | **Deferred, not upstream, not fork-only**: `Monitor.node` is NOT wired into any of the five full-app assembly sites (each gained a one-line `// Monitor.node: absent by decision` comment instead, per this file's own "Adding a new global `.node`?" discipline) — nothing on any runtime consumes `Monitor.Service` yet (no `tool/monitor.ts`, no startup recovery hook), and diary 2530's Delta 1/2 explicitly moved `MonitorRuntime` off the `SessionExecution`-unbound-port shape onto a bound-default-plus-typed-error pattern for the execution-phase PR — wiring an unconsumed node into production now would be speculative surface. The execution-phase PR (`monitor/process.ts`, `monitor/condition.ts`, `monitor/output.ts`, `tool/monitor.ts`, `monitor_check` table, the five-site wiring, and the startup `recover()` call) is what THE MONITOR GATE (containment/authorization/redaction/restart) blocks on |

| Command Monitor, execution phase: `packages/core/src/monitor/process.ts` (one check attempt — resolves the command's location via `LocationMutation`, asserts BOTH the `monitor` capability and the same `bash` command permission `tool/bash.ts` asserts, runs it through `AppProcess.run` with a bounded timeout/output cap), `monitor/condition.ts` (`exit-code`/`regex`/`json`/`plugin` evaluation — plugin always reports not-triggered in this slice, an invalid regex/JSON reports not-triggered rather than throwing), `monitor/output.ts` (redact-before-persist, tail preview + checksum + byte count always computed on the redacted text, full text written to managed storage only when the preview doesn't already cover it), `monitor/runtime.ts` (`MonitorRuntime.Service` — `start`/`cancel` backed by a dedicated `SessionRunCoordinator` instance per diary 2530's open question 3, deterministic `msg_monitor_<id>_<seq>` message ids making wake delivery idempotent by primary-key collision rather than new plumbing), `monitor_check` table (one row per check attempt), two new durable events (`MonitorEvent.Completed` — maxAttempts exhausted without ever triggering, a gap PR1 left between `Monitor.Status`'s 7 values and its own 7 declared events; `SessionEvent.ExternalSignal` — the durable record behind a monitor's chat-visible synthetic message) (TKT-322) | Continues the same upstream-TODO acceptance bar as PR1's row above (`tool/bash.ts:70-77`'s durable status / restart recovery / owned observation) — this is the part of that bar PR1 explicitly deferred: an actual process gets spawned, watched and reported on now. Design note diary 2435 §1/§3/§4 (containment matrix, output bounding, authorization reuse), diary 2530 (layer-graph deltas: Delta 1 bound-default-not-unbound, Delta 2 exactly-once construction, open question 3) | not yet filed | Adds `monitor_check` (FK cascade to both `monitor` and `session` — the latter is the literal `session_id` column `session-purge.test.ts`'s inventory scan requires; unique `(monitor_id, check_seq)`) and 2 new durable event types, additive — no existing decoder changed. `MonitorRuntime.UnavailableError` is a typed failure, not a schema type (mirrors `McpRuntime.UnavailableError`, TKT-323) | `20260812095536_monitor_check`: additive DDL only, no backfill. Generated via `bun script/migration.ts --name monitor_check`, `--check` clean | **Deferred, not upstream, not fork-only**: `MonitorRuntime.node` ships as a BOUND default (`makeGlobalNode` with a typed `UnavailableError` layer, per diary 2530 Delta 1 — never `LayerNode.unbound`, since an unbound node takes the whole compiled bundle down on any reach, not just the consumer) but, like `Monitor.node` before it, is NOT wired into any of the five full-app assembly sites — each gained an updated `// Monitor.node / MonitorRuntime.node: absent by decision` comment (correcting PR1's own comment, which had said this PR would add it) — because nothing on any runtime calls `start()`/`cancel()` yet: still no `tool/monitor.ts`, still no startup `recover()` hook. Plugin-source monitors are declared-but-not-executed (`MonitorCondition.evaluate`'s `"plugin"` case, `runOne`'s immediate `Failed` for non-`"command"` sources) — diary 2435 §5's plugin failure taxonomy is still an open question. `MonitorProcess.check`'s timeout path returns empty output rather than the partial capture up to the timeout — inherited unchanged from `AppProcess`/`tool/bash.ts`'s own identical gap (verified, not assumed), and fixing it is a shared-infrastructure change (switching to `runStream` with a caller-side accumulator) out of this slice's scope. The tool-wiring PR (`tool/monitor.ts`, the five-site wiring, the startup `recover()` call) is what THE MONITOR GATE still blocks on |

| Command Monitor, tool-wiring phase (final slice): `packages/core/src/tool/monitor.ts` (`monitor_create`/`monitor_list` — declaration-only, depends on `Monitor.Service` alone, never `MonitorRuntime`; no `monitor_cancel` in this slice, since `MonitorRuntime.cancel` is the only thing that could back it and shipping a cancel tool with nothing wired to cancel would be the half-finished implementation CLAUDE.md argues against), `Monitor.recoverNode`/`MonitorRuntime.liveNode` wired into all five assembly sites (`Monitor.recoverNode` — declare + startup `recover()` — everywhere; `MonitorRuntime.liveNode` only at `packages/server/src/routes.ts` and `packages/opencode/src/server/routes/instance/httpapi/server.ts`, the two sites that actually serve live sessions — `cli/serve.ts`/`sdk-next/opencode.ts` reach the real runtime *indirectly* through those same two packages' `createRoutes()`/`createEmbeddedRoutes()`, and `app-runtime.ts` has no `SessionExecution` wiring or `locationServices` reach at all, so live monitor execution has no consumer there). `MonitorRuntime`'s check-time authorization redesigned per diary 2669 review: resolves `LocationMutation`/`PermissionV2` **per check** via `LocationServiceMap.Service.get(session.location)` (through a new `SessionStore` construction-time dependency), not once at construction — fixes both the single-location-only bug PR2 shipped with (proven in a test harness that only ever exercised one location) and gives "authorize per check" (a revoked permission takes effect at the very next check, diary 2669's ruling) for free from the same change. Monitors now START reactively: `MonitorRuntime.layer` subscribes to `MonitorEvent.Created` (`events.subscribe(...).pipe(Stream.runForEach(...), Effect.forkScoped({startImmediately: true}))`, the same shape already used by `plugin/models-dev.ts`) rather than being started by a caller — the tool never calls `start()`, and `recover()`'s own non-tool path needed one anyway, so this is the one path that serves both, "un-forgettable" at any future assembly that wires the real runtime (TKT-322 diary 2669, Ethan's ruling; verified before building it — no other production caller of `.start()` existed, and the subscribe+forkScoped pattern is an established one, not a first use) (TKT-322) | Same acceptance bar as the execution-phase row above — this is the piece that finally lets `THE MONITOR GATE` actually run: declare → trigger → wake now works end to end on a real assembly, closing PR2's own "not wired into any assembly site" gap. Design note diary 2669 (Henry, the `LocationServiceMap` cycle review that produced the per-check redesign) | not yet filed | No schema/table changes for the wiring itself. `MonitorProcess.AuthorizationRefusedError` is a new typed failure (not a schema type) carrying `effect: "deny" \| "ask"` | none | **Deferred, not upstream, not fork-only — TKT-392 tracks it, not a bare comment (feedback #199's own rule: a gap without an id exists only in the comment that names it)**: the operator's authorization ruling (diary 2678) specifies three outcomes for a monitor's owning agent permission policy — `allow` runs unattended (shipped), `deny` visibly fails (shipped), `ask` should PARK the check as a new `waiting-on-user` `Monitor.Status` and resume on approval through the existing `PermissionV2` request/reply flow (NOT shipped). This PR's interim treats `ask` identically to `deny` — fail-closed, refused, never silently skipped, and the refusal message names the exact remedy (`MonitorProcess.AuthorizationRefusedError`: "this tool's permission is ask for action ...; monitors cannot prompt... set it to allow, or approval-flow support arrives with TKT-392") — deliberately never the looser direction (never treated as `allow`), the only acceptable direction for an interim on an authorization path. TKT-392's spec (settled, not just filed) is Henry's three-item scoping from the review thread: (1) the new `Monitor.Status` value plus whether `recover()`'s orphan sweep needs to also catch a process that died mid-park; (2) a reactive resume-on-approval subscription symmetric with the `Created`-event start path (an approval/reply event to subscribe to was not yet confirmed to exist); (3) whether the parked request's own exactly-once identity reuses `(monitor_id, check_seq)` or needs its own key. `permission.ask()` (evaluate, non-blocking, already used internally by `PermissionV2.assert`'s own "ask" branch) rather than `permission.assert()` (evaluates THEN BLOCKS the caller on the pending request's reply, correct for an interactive tool call, wrong for an unattended monitor) is settled as the right primitive for TKT-392 to build on, not just this interim |

| Docs ship in the distribution (Sean-directed): `packages/opencode/script/build.ts` builds `packages/web` (the real Astro+Starlight docs/marketing site) and embeds its English-only static output into the compiled binary the exact way the web UI already is (`with { type: "file" }` imports synthesized into a virtual `opencode-docs.gen.ts` module, added as an extra `Bun.build` entrypoint) — `packages/web` builds all 17 non-English locales too (~85MB), filtered to the root/English subtree only (~27MB) since nothing serves the rest yet (`NON_ROOT_DOCS_LOCALES` in `build.ts`, revisit if a hosted multi-locale deployment ever wants the full set). New `packages/opencode/src/server/shared/docs.ts` serves it at `/docs/*` (a specific route ahead of the web UI's own catch-all, matching `/doc`'s existing precedent), gated by a new `OPENCODE_DISABLE_EMBEDDED_DOCS` flag — deliberately **no upstream-proxy fallback** the way `ui.ts`'s `UI_UPSTREAM` has one: serving `docs.opencode.ai` when this fork's own bundle isn't embedded would document a different program, the exact failure TKT-328's diary 2528 found in the console's `openapi.json` proxy; not embedded means a clear 404, never a silently-wrong document. `packages/web/config.mjs`'s `url`/`github` retargeted to this fork's own identity (Ethan/Sean ruling, diary — no fixed external origin to name for `url`, since docs run on whatever host/port an instance actually binds to; `github` → `github.com/Draugur-AI/opencode`, factual, issues enabled there), `discord` removed entirely rather than retargeted (pointing fork users at upstream's community was ruled wrong, and inventing one is not this PR's call — one-line restore if an operator supplies a real one). In-app help links retargeted to the local `/docs` route: TUI's `docs.open` command (`sdk.url`-relative, mirrors how the TUI already knows its own connected server), and two specific doc-page links in the browser app (`settings-v2/general.tsx`'s themes link, `dialog-custom-provider.tsx`'s custom-provider link, both `location.origin`-relative). End-to-end smoke-tested against a real compiled `--single` binary: `/docs/`, `/docs/themes/`, `/docs/providers/` all 200 with the fork's own GitHub links and no Discord; `/docs/es/` (a filtered-out locale) and `/docs/nonexistent/` both 404 correctly; `OPENCODE_DISABLE_EMBEDDED_DOCS=true` correctly serves the "not embedded" 404 instead. (TKT-391) | The in-app help link pointed at upstream's docs, which no longer describe this fork's own (increasingly diverged) behavior; bundling the fork's own docs keeps them honest with what's actually shipped, per Sean's own framing 2026-08-12 | not yet filed | No schema/protocol changes. New `packages/opencode/src/server/shared/docs.ts` module; `RuntimeFlags.Service` gains `disableEmbeddedDocs` | none | **Real, orphaned finding, not fixed**: `packages/docs/` (the Mintlify-schema `docs.json` a literal reading of "docs" might target) is DEAD — no `package.json`, not a workspace member, never referenced by any build/CI, still the unedited Mintlify starter boilerplate (its own README still says "click the green Use this template button"). `packages/web` (Astro+Starlight) is the real docs site with actual content — this row bundles that one. Left `packages/docs/docs.json`'s own dead `openapi` pointer retargeted to the local symlinked file as one cheap line, but did not otherwise touch or delete the dead package (mention it, don't silently "fix" scaffolding nobody asked about, don't delete work that might be someone's in-progress plan without asking — CLAUDE.md). **Deferred, filed as feedback #201, not fixed here**: a much larger set of upstream-pointing references audited per this ticket's own rider (console's live server-side proxies to `docs.opencode.ai`/`stats.opencode.ai`, the GitHub-releases download route, legal pages naming `opencode.ai`, the system prompt's bug-report destination, AUR/Homebrew/AppStream release-pipeline identity, two different upstream Discord invites, and the `opencode.ai/zen` paid-credits upsell) — all one consolidated "fork product-identity decisions" item per Ethan's ruling, since they're business/product-identity questions for the operator, not code hygiene an agent should drive by on. `console/app/src/routes/openapi.json.ts`'s own upstream `raw.githubusercontent.com` fetch is confirmed already queued on TKT-328's own ticket board (not FORK.md's rows, which cover the unrelated vendored-client-tarball wart) — left untouched here, TKT-328 owns it. The desktop app's native OS-level Help menu (`packages/app/src/desktop-menu.ts`) still hardcodes `opencode.ai/docs` — a static, pre-built menu structure (not a component with runtime context the way the TUI/browser-app fixes above had), retargeting it correctly needs the app's own command-dispatch system (the file's own `exportLogs` entry already uses `command:` rather than `href:` for exactly this reason) rather than a plain string swap; flagged as a residual follow-up, not attempted under this PR's time budget |

| V2 compaction trigger: anchor-on-real-usage estimation (`packages/core/src/session/compaction.ts`'s `findAnchor`/`anchoredEstimate`/`exceedsCapacity`). Prod-confirmed bug (diary 2600, TKT-377): the trigger's `Token.estimate` char/4 heuristic under-counts structured tool output by up to 31% (live-measured against `usage.prompt_tokens`), which #34 patched with a blanket 1.2x safety factor over the WHOLE conversation estimate. This PR replaces that: the most recent assistant message with recorded `tokens` (real `usage.prompt_tokens`/`.output` from the provider, already on `SessionMessage.Assistant` — no new plumbing) becomes an anchor; only `entries` added since that anchor are still char-count estimated, and the safety factor now applies to that (typically small) delta only, not the whole conversation. Error shrinks as the session grows instead of compounding with it. No anchor yet (session start, or immediately after a compaction with no new assistant turn since) falls back to the full char-count estimate, unchanged from before. (TKT-377) | Design note diary 2584 §5: "the estimator should anchor on that measured value and estimate only the delta added since it... self-correcting, costs no new plumbing, and its error shrinks as the session grows." #34 shipped the interim (blanket 1.2x) explicitly pending this | not yet filed | none — no schema/table change; `SessionCompaction.Entry` and `anchoredEstimate` exported from the existing module for direct testing, same pattern as `exceedsCapacity` in #34 | none | **fork-only** — the estimator is fork-built (diary 2584/2594/2600 measured this fork's own char-count heuristic against this fork's own trigger code); no upstream equivalent to propose it against. `ESTIMATOR_SAFETY_FACTOR`'s removal condition is documented in its own comment: live-measure the delta-only estimate specifically (not the whole-conversation numbers this factor was originally set from) before dropping it. **Legacy path** (`packages/opencode/src/session/overflow.ts`'s `isOverflow`) needed no equivalent change — verified (diary 2628, independently confirmed by Ethan) that it already compares real `lastFinished.tokens` usage, never a char-count estimate; #34's fix there was the reserve floor, not an estimator. The legacy and V2 tail-budget SELECT steps (`compaction.ts`'s own `select()` in both packages, deciding how much recent history survives a compaction) still use raw char-count and were NOT touched here — that is a different estimation problem (sizing an arbitrary retained turn against a budget, not "is total context over the window") with no equivalent real per-turn anchor available, and out of diary 2584's original scope |

`e2e` (in `test.yml`), `nix-eval.yml`, `pr-management.yml`'s `check-duplicates` job, and most of
the release/publish/deploy/beta/docs/notify/storybook/triage/stats workflows are **not** in this
ledger: they remain untouched and still non-functional on this fork (same `blacksmith-*` problem,
out of scope for the tickets that touched CI so far). That is inherited non-function, not a
divergence we introduced — see "CI runner reality" for the full list and why a blanket
find/replace across all `blacksmith-*` usages would be wrong (some, like `publish.yml`'s ARM64
cross-compile job, use Blacksmith for a real capability GitHub-hosted can't replicate).

**Resolution** is one of:

- **upstream** — intended to be proposed back to `anomalyco/opencode`; link the issue/PR once filed.
- **keep** — fork-only by design (e.g. product positioning specific to this deployment); state why
  it can never go upstream.
- **remove** — a temporary compatibility shim (a V1 adapter, a migration column) with a stated
  condition for deleting it (see the build post's "Migrations and compatibility" section and its
  vertical-slice removal steps).

A row is never deleted, only marked resolved — the ledger's value is in showing what has *already*
been reconciled, not just what is currently outstanding.

## Known issues

- **`dv` (Dhivehi) is missing 8 i18n keys**, carried as a scoped, evidenced exception in
  `packages/app/src/i18n/parity.test.ts`'s `KNOWN_MISSING` allowlist rather than silently failing
  parity or being faked with unverified content — see that file for the full round-trip evidence
  and feedback #171 for the fix-forward (a different model or a human; `litellm/qwen3-6` is
  disqualified for this locale, two strikes in two different failure modes).
- **17 locales (zh, no, fi, am, bg, bn, dv, dz, fo, hy, is, lv, mk, mn, my, sr, tg) are missing some
  or all of TKT-335's 21 goal/ledger i18n keys**, same `KNOWN_MISSING` mechanism, same
  `litellm/qwen3-6` batch translator — this time the model silently timed out per-locale (batch
  script exits 0, no content ever gets written) rather than producing bad content, after 6+ resume
  rounds over ~2.5h. See feedback #182 for the full per-locale evidence and fix-forward.

## Decision reversal: `readTarget` is always redacted, no raw-secret escape hatch (TKT-323, feedback #191)

**Chunk 1 shipped `readTarget` (`GET /api/config/document/target/:targetID`) returning MCP secrets
in the clear — `text` (raw file) and `parsed` (that raw text parsed), neither passing through the
redactor `computeEffective` already used on the sibling `effective()` endpoint, same protocol
group.** Confirmed live: a config with `mcp.servers.<name>.environment.<KEY> = <real secret>`
returned that exact value verbatim from `readTarget`, and `[redacted]` from `effective()`, same
request shape, same secret. Filed as feedback #191, verified before any severity was assumed
(Henry's design note read the code; the live-request confirmation — real secret in, real secret
out — is what turned the reading into a ruling).

**The original rationale, reversed.** `document.ts`'s own comment (pre-fix) argued the
direct-file-editing escape hatch needed `readTarget`'s raw text to stay byte-real, or a patch
computed against a redacted view would corrupt the file's real secret values on write. That
concern does not hold against the shipped write model: `applyPatch` never serializes text
wholesale — `ConfigDocument.Patch` is a typed, allowlisted union of field operations
(`mcp.server.set`/`mcp.server.remove`), applied against text the **server re-reads itself**. A
field the client did not edit is simply absent from the patch and is never written back. An editor
working from a redacted display view cannot corrupt a secret it never saw, through any shipped
endpoint. No consumer of `readTarget`'s real secret values existed at the time of the fix (Henry
enumerated call sites in parallel with the verification).

**The rule now:** every API read response — `readTarget`, `effective`, `validatePatch`'s
`preview`, every future `*.catalog.list` — is unconditionally redacted. There is no operation that
reveals a real secret value over the API. **The escape hatch is editing the config file on disk
directly**, not an API response; the build post's migration step 9 is clarified to say so
explicitly, since "always show the selected source document" read ambiguously against "secret
values are write-only and redacted in read responses" otherwise.

**Corollary shipped in the same fix:** `applyPatch` rejects (`RedactedValueRejectedError`, mapped
to `InvalidRequestError`, 400) a patch that would write the literal sentinel `"[redacted]"` over a
secret field. Without this, a UI that reads a redacted value, never touches it, and patches the
field straight back would silently persist the sentinel as the real secret — indistinguishable
from a successful save until the integration stops authenticating. Only meaningful now that
`readTarget` never returns a real value for a client to accidentally echo back; it was unsafe to
add before the leak was fixed (nothing prevented a real value from round-tripping correctly, so a
sentinel check would have been the only thing rejecting a legitimate value that happened to equal
the placeholder string by coincidence — vanishingly unlikely, but the ordering matters).

**Reveal-op path back, if one is ever explicitly authorised.** This reversal does not foreclose a
future "reveal" capability — it is reversible by addition, not by weakening the default. A
dedicated, explicitly-authorized operation (its own audit trail, its own authz check, never bundled
into a general read path) could still return a real secret value on request. Nothing in this fix
prevents adding one later; it only ensures no *existing* read path does it implicitly. If one is
ever built, it must not reuse `readTarget`'s response shape for it — a field that is sometimes
real and sometimes redacted, on the exact same endpoint, is the ambiguity this fix exists to
remove.

**Mechanical mitigation for the next secret-shaped field** (chunk 3 adds plugin and profile config
shapes): `mcpSecretPaths` in `document.ts` is the one enumeration every redaction path shares —
the object redactor, the raw-text redactor, and the write-time sentinel check all read the same
list rather than three independently maintained ones. A new secret field still requires someone to
remember to extend it; the allowlist stays hand-written by design (chunk 1's own choice, to avoid
a key-name scrubber that both misses fields like `client_secret` and over-redacts innocent ones),
but at least a change to it now fixes read, preview, *and* write-rejection in one place instead of
three.

## PR conventions

- **Vertical slices, package boundaries preserved.** Follow the dependency direction in the build
  post: `packages/schema` → `packages/core` → `packages/protocol`/`packages/server` →
  `packages/client` → `packages/app`. A PR that reaches across that graph without a schema-first
  change underneath it is doing the redesign out of order.
- **No formatting, generated-code, or renaming churn.** These are exactly the diffs that make
  every future sync more expensive without moving the redesign forward. If a file must be
  reformatted, do it in its own commit with nothing else, and expect it to be deferred rather than
  bundled into a feature PR.
- **Generated clients are regenerated, never hand-edited.** After any `packages/protocol` change:
  `bun run --cwd packages/client generate` then `bun run --cwd packages/client check:generated`.
  A hand-edited generated file is treated as a bug, not a shortcut.
- **The shared test rig grows in the slice that needs it.** `@opencode-ai/test-rig` holds the
  lifecycle transition model and the delivery simulator (duplicate / reorder / delay / gap), and is
  imported by both `packages/core` and `packages/app` — it lives in its own package because
  `packages/core` exports only `./src/*`, so a rig under `packages/core/test` is unreachable from
  the app. Whichever slice first needs a capability it lacks — fake clocks, or generalising the
  simulator to project preferences, goal versions, ledger supersession, Monitor status — adds that
  capability in **its own PR**, rather than filing a standing "generalise the rig" ticket that
  nobody can scope. Keep the model written from the spec, never derived from the reducer under
  test: it has now caught two production defects precisely because it was free to disagree.
- **Every slice PR adds its ledger row.** Missed twice in a row on the same file list (#7, #10) —
  that means the reminder needs to live in the mechanism, not in memory. A reviewer checks the
  PR's file list for a `FORK.md` diff before approving anything that touches schema, migrations,
  or CI; its absence on an intentional-divergence PR is a request-changes, not a nit.
- **Fork-only behavior stays behind capability discovery while contracts are experimental** — not
  behind scattered build-time flags. A client (or upstream) that does not know about a fork-only
  capability should degrade cleanly, not fail to build or silently omit behavior.
- **Every PR carries its validation dossier** per the validation post: invariants touched,
  fixtures exercised, crash/differential/browser cases added as applicable, performance budget
  before/after where relevant, and compatibility paths retained plus their removal condition.
- **Automated (Copilot) review runs on fork PRs as of 2026-08-11** (see "Does automated review run
  on fork PRs?" below — ruleset `20729187`, first real firing on TKT-323/#191/PR #32 caught two
  genuine findings). Pass `--base dev` explicitly at PR-open — a wrong-based PR gets no review,
  silently — and confirm the review actually fired before treating its absence as a clean diff.
  It runs alongside peer review, not instead of it; local per-package tests remain the primary
  gate underneath both.
- **LLM-generated source is checked like source, not trusted like data.** A `script/translate-app.ts`
  batch (TKT-314) wrote a syntax error into one locale file out of 63 — a smart quote opened a
  string, a plain ASCII quote closed it, breaking the literal — invisible on read, and it segfaulted
  the test runner rather than failing cleanly. Before committing any batch of LLM-written or
  LLM-translated files: a per-file syntax-only build check (e.g. `bun build <file> --outfile=/dev/null`
  for each), a diff check that every changed line is a pure addition (a `-` line is a collateral edit,
  not a translation), a full monorepo typecheck, and the relevant parity/lint suite green — in that
  order, before the commit.
  - **A fourth corruption class only the full typecheck catches (TKT-335): duplicate object-literal
    keys.** A batch re-emitting an already-present key (rather than editing or skipping it) passes
    BOTH of the checks above clean — `git diff` sees it as a pure `+` addition (re-adding a key is
    not a removed line), and a plain `bun build` never flags it (JS silently allows duplicate keys
    at runtime, last one wins). Only `tsc`/`tsgo`'s stricter object-literal check
    (`TS1117: An object literal cannot have multiple properties with the same name`) catches it.
    The full monorepo typecheck step above is not optional — it is the only instrument that sees
    this class.
  - **Never resume a batch without confirming the previous run actually stopped (TKT-335).**
    Two overlapping `translate:app` runs against the same tree raced each other for part of a
    session — a `ScheduleWakeup`-driven resume was triggered before the prior run's completion was
    confirmed, not after it. `pgrep -f 'translate-app.ts'` (or equivalent) before every resume;
    two processes writing the same locale files concurrently is a plausible contributor to some of
    the truncation/collateral-edit corruption these checks exist to catch, not just the model's own
    failure modes.

## Adding a new global `.node`? Check every assembly site that actually serves it.

A `makeGlobalNode`-tagged service (`ProjectV2.node`, `SessionGoal.node`, `EventV2.node`, …) is a
process-wide singleton, and `AppNodeBuilder`/`AppNodeBuilderV1`'s transitive auto-discovery of a
new node's *own* dependencies is **not reliable past a certain graph size** — TKT-315 and TKT-317
independently hit this from both directions: adding `ProjectV2.node`'s own new dependencies broke
type-level resolution in two unrelated packages, and *not* explicitly listing `SessionGoal.node`/
`SessionLedger.node` in a full-app composition site left those routes returning `500: Service not
found` at runtime, silently, because nothing forced the omission to surface until something else
exercised that exact path. **Do not rely on auto-discovery for a new global node. List it
explicitly at every full-app assembly site whose runtime can actually reach it.**

**"Every site" is not "every site, uniformly."** The five sites exist because different runtimes
serve different features — that is the reason there are five instead of one. Adding a node
everywhere by default defeats the split: it was tried once (an earlier version of this section
said exactly that), and it is wrong, because it makes "listed" stop meaning "reachable" and turns
every future audit back into a guess. Before adding a node to a site, trace whether that site's
own consumers can actually reach the service — grep for direct imports of the service/its data
type from code the runtime executes (not just from HTTP-only handlers), the way TKT-315 confirmed
`ProjectV2` for the CLI/TUI runtime via `project/bootstrap.ts` (imported by
`app-node-builder-v1.ts` itself — always-on, not conditional) and confirmed `SessionGoal`/
`SessionLedger` via the built-in `goal_get`/`goal_update_progress`/`ledger_add` tools every
session gets regardless of runtime.

- **If reachable: list it, with a one-line comment naming what reaches it** (a route, a tool, a
  bootstrap dependency) — so the entry is a traced fact, not a copy-paste.
- **If not reachable: leave it out, with a one-line comment saying so** (`// absent by decision:
  this runtime does not serve <feature> — see TKT-nnn`). Absence is a decision, and it needs the
  same trail a presence does, or the next person can't tell "checked, doesn't apply" from
  "forgot."

Every global node adds real per-process construction cost at the site that builds it, even when
it never does I/O — see the eager-construction note in "Resolved CI reds" below
(feedback #150). Uniform addition does not just blur the checklist, it taxes every runtime for
every feature whether that runtime uses it or not.

**The five full-app composition sites** (each lists most/all global nodes; found by `grep -rln
"AppNodeBuilder\.build\|AppNodeBuilderV1\.build\|LayerNode\.group(" packages/ --include="*.ts"
--include="*.tsx" | grep -v "/test/" | grep -v "\.test\.ts$"`, then narrowed to the entries whose
own node count made clear they were "assemble everything" sites rather than one narrow feature):

1. `packages/opencode/src/server/routes/instance/httpapi/server.ts` — the `app` list (~63 nodes).
   The V1 `HttpApiApp`; this is what `test:httpapi`'s exerciser actually runs against.
2. `packages/opencode/src/effect/app-runtime.ts` — `AppLayer` (~52 nodes). Powers the interactive
   CLI/TUI (`opencode` run directly, not through the HTTP server) — a gap here is invisible to any
   HTTP-shaped test. `ProjectV2.node`/`SessionGoal.node`/`SessionLedger.node` are listed here,
   traced reachable: `ProjectV2` through the V1 `project/project.ts` adapter, imported by
   `project/bootstrap.ts`, which `app-node-builder-v1.ts` (this site's own builder) depends on
   unconditionally; `SessionGoal`/`SessionLedger` through the built-in `goal_get`/
   `goal_update_progress`/`ledger_add` tools, part of the standard toolset every session gets
   regardless of runtime. Listing them here has a real, measured cost — see feedback #150 in
   "Resolved CI reds" below.
3. `packages/server/src/routes.ts` — `applicationServices` (~15 nodes). The current v2
   `createRoutes`/`createEmbeddedRoutes`, used by `packages/cli` and `packages/sdk-next`.
4. `packages/cli/src/commands/handlers/serve.ts` — the CLI daemon's own explicit
   `AppNodeBuilder.build(LayerNode.group([...]))` in `bind()`.
5. `packages/sdk-next/src/opencode.ts` — the embedded-server SDK's own explicit list. Also needs
   the type-level `HttpRouter.provideRequest(...)` treatment below, not just the node list.

**Not on this list, and shouldn't be added to it:** `packages/core/src/location-services.ts`
(`locationServices`, ~36 nodes) looks similar by node count but is a **different category** —
per-location/per-workspace scoped services (`LayerNode.unbound`/`LocationServiceMap`), rebuilt per
directory, not process-wide singletons. A global `.node` does not belong there. Everything else
`grep` finds under `packages/` outside `test/` is a narrow, single- or few-node build for one
specific feature (e.g. `packages/opencode/src/control-plane/workspace.ts`'s two `InstanceStore.node`
uses) — not a checklist target.

**If the new node is consumed through `HttpRouter.toWebHandler`** (as in `sdk-next/opencode.ts`),
listing it in the node graph is necessary but not sufficient. `HttpRouter.toWebHandler`'s type
distinguishes `"Requires"` from `"GlobalRequires"` request-kinds, and only
`HttpRouter.provideRequest(layer)` discharges the latter — plain `Layer.provide(...)` silently
leaves it unsatisfied and the handler's call signature shifts from one argument to two
(`(request, context: Context<...>) => Promise<Response>`), a type error at the call site, not at
the provide site. `HttpRouter.serve` (used by `packages/cli`'s daemon) does not draw this same
distinction, which is why the equivalent fix there was just adding the node to the existing
`Layer.provide(AppNodeBuilder.build(...))` list.

### A process singleton is a singleton PER MEMO MAP (TKT-349)

Listing a global node at every reachable assembly site (above) is necessary but **not
sufficient** on its own. Two separate `AppNodeBuilder`/`AppNodeBuilderV1.build(...)` (or
`Layer.buildWithMemoMap(...)`) calls that both reach the same global node, each without a
**shared** `MemoMap`, construct it **twice** — two live, independent instances of what the
codebase assumes is one process-wide singleton (`SessionExecutionLocal`'s coordinator, in the
case that surfaced this: a keyed `Map` + `FiberSet` split in two, each half seeing only some of
the sessions it should be coordinating). A green functional test suite does not catch this class
of bug — every individual assertion can still pass against whichever half of the split it
happened to be routed to. **Only a construction counter does**: instrument the layer's own
construction path and assert it runs exactly once across every boundary that is supposed to
share it.

The fix is always the same shape: **pass the shared `memoMap` instance
(`@opencode-ai/core/effect/memo-map`) at every assembly boundary that is supposed to produce one
shared instance of a node.** Production's own server assembly already did this correctly
everywhere the `httpapi-exercise` test harness did not, which is why the split was invisible until
a change (a since-reverted TKT-349 session-removal adapter prototype) added a new edge that made a
previously-single build path fan out across two boundaries. That prototype surfaced two more
boundaries this rule applies to and is still open, **not yet fixed**:

1. The V1 `session.remove` adapter itself — routing it through `SessionV2.Service` means V1's
   `Session.node` needs `SessionV2.node` as a dependency, which reaches `SessionExecution.node`
   (unbound) from **every** consumer of `Session.Service`, not just `remove`. That broke 35
   otherwise-unrelated test fixtures across the suite that build `Session.node` in their own
   narrow harness and never needed a `SessionExecution` replacement before. The fixtures were not
   wrong — the edge's shape was: a whole-service dependency for what should be one function's
   concern. Needs a narrower capability (a `serviceOption`-style optional dependency, or a
   narrower interface `remove` alone requires) rather than 35 individual fixture patches.
2. `acp/service.ts`'s `makeDirectoryService` is **not** a true process-global the shared-memoMap
   rule applies to as-is: `Directory.Loader`'s replacement is parameterized by the caller's own
   `sdk` (a distinct `OpencodeClient` per ACP connection), so passing the shared memoMap dedups
   instances that are legitimately supposed to stay distinct — confirmed by real ACP test
   failures (wrong JSON-RPC error codes) the moment the shared memoMap was applied there. Needs
   its own per-sdk-vs-global memo structure, not a blanket pass.

Both are tracked open on TKT-349 pending a designed shape for each — the pre-existing V1
`session.remove` raw hard-delete (no tombstone, no crash safety) remains live for its CLI/ACP/
teardown callers until the first is resolved. No app-facing path reaches it after this PR: the
app's own "Delete…" action was moved to the `trash` lifecycle route directly (see the app-side
row below), independent of this adapter entirely.

**Where a fresh, unshared `MemoMap` is deliberate** (per-listener config isolation in
`server/server.ts`'s `startListener`, for example), that is legitimate — but the code must say,
at the point the fresh map is created, which singletons it is knowingly duplicating as a result.
A silent fresh map reads identically to a forgotten shared one; only the comment tells the next
person which case they are looking at.

### An unbound node in a shared group is fatal to every assembly that does not replace it (TKT-323)

`packages/core/src/location-services.ts`'s `locationServices` is compiled by more than one
assembly — `buildLocationServiceMap` (`LayerMap.make`, one merged layer per `Location.Ref`,
`idleTimeToLive: 60 minutes`) is called from `httpapi/server.ts` directly and auto-discovered
by `AppNodeBuilder.build` for `packages/server/routes.ts` (used by `packages/cli`'s `serve` and
`packages/sdk-next`) whenever `LocationServiceMap.node` is reachable and unreplaced. **`unbound`
does not mean "absent and skippable" — it means "fatal unless replaced."** `LayerNode.compile`
throws on any unbound member of the group being compiled, and that throw takes down the **whole**
per-location bundle for every route in that assembly, including routes that touch nothing related
to the unbound member. The thrown message names the *unbound service*, never the *node whose deps
reached it*, so the stack points at `location-services.ts` and gives no hint which member is at
fault — read it as "a dependency this assembly cannot satisfy was pulled into a shared graph," not
as "a binding is missing" from the file the stack trace names.

Observed twice in one diff, TKT-323 chunk 2, building the `McpRuntime` port for live MCP status:

1. **67 failures** — the adapter's `deps:` listed `InstanceStore.node`, which transitively reaches
   `InstanceStore.bootstrapNode` (`project/instance-store.ts:205`), itself `LayerNode.unbound` with
   its *only* replacement anywhere in the tree at `effect/app-node-builder-v1.ts:6`'s
   `bootstrapReplacement`. **Any node depending on `InstanceStore` is assemblable only through the
   V1 builder** — this is load-bearing, not incidental, and is currently what keeps V1 instance
   addressing out of the V2 location pipeline. A `Unbound layer node: @opencode/InstanceBootstrap`
   error means "a V1-only dependency has been pulled into a V2 graph."
2. **12 failures** — even after removing that `deps:` entry, `McpRuntime.node` **itself** was
   `LayerNode.unbound`, sitting in `locationServices` directly. Every assembly that does not
   supply a replacement (i.e. everything except `httpapi/server.ts`) hit the same fatality on the
   port's own tag.

Both are `LayerNode.compile` throwing on an unbound node and taking the whole per-location bundle
with it — the *same* mechanism, twice, at two different nodes. **Second bundle-poisoning incident
overall, a different mechanism from the MemoMap split above** — that one silently duplicated
construction; this one rejects the graph outright. **Before adding any node to a shared group,
enumerate every assembly that compiles that group** — a replacement supplied at one call site does
not cover the others.

**The fix: bind the port to a truthful default, never leave it unbound in a shared group.**
`McpRuntime.node` now ships **bound** to a default (`deps: []`) whose `status()` always fails a
typed `McpRuntime.UnavailableError` — replacements substitute a bound node exactly as they would
an unbound one, so `httpapi/server.ts` still supplies the live implementation the same way. The
general form: **unavailability must be expressed in the value returned, never in the absence of a
binding — because in a shared group, absence is fatal.** A no-op/disabled fallback layer was
rejected earlier on this same ticket for fabricating a status a user could mistake for togglable;
a bound default that *fails informatively* satisfies both constraints at once.

**A closed adapter still must not rebuild what the app tree already built.** The live
implementation (`packages/opencode/src/mcp/runtime.ts`'s `McpRuntimeLive`) reads `MCP.Service` /
`InstanceStore.Service` via `Effect.serviceOption` **inside its `status()` method body**, `deps:
[]` on the node itself — never a `deps:` graph edge (which is what caused the 67), and never a
second, independent `AppNodeBuilder.build(...)` call to obtain a "resolved" instance (which would
be the MemoMap-split defect above, moved into a closure where no graph analysis can see it — a
real, considered, and rejected alternative on this ticket). `Effect.serviceOption` reads the
ambient Context without adding a static requirement, so the layer stays `Layer.succeed` (`R =
never`) and reuses whatever single instance the assembly's own `app`/`AppLayer` tree already
constructed. The underlying mechanism this reuse depends on — a shared MemoMap dedupes a node
reachable from two separate compiles — is proven directly by
`packages/core/test/config/mcp-runtime.test.ts`'s construction-counter test, the same instrument
that caught the SessionExecutionLocal split-brain above; the ambient `Effect.serviceOption` read
itself has no graph edge to duplicate in the first place, which is the point, not something a
counter needs to separately re-prove. **Before
building an ambient-read adapter, probe first**: confirm the target service is actually present in
the ambient context at the real call site (not assumed) — an adapter reading ambient context that
is never populated there is permanently, silently unavailable, which is a design defect the same
shape as fabricating a status, just quieter.

**One piece of advice, two sites, opposite verdicts — name which site it's about.**
`Effect.serviceOption` is exactly right for a **consumer** choosing unavailable-vs-status (the
handler) and for an **adapter's own dependencies** (reading ambient context, no static
requirement). It is **no defence at all** against a **compile-time** rejection of an unbound node
in a shared group, because no effect ever runs — compilation rejects the graph first. Two
different sites; both statements are true; conflating them costs real diagnosis time.

**A construction-counter test asserts the deduped count AND the split count, or it is not a
guard.** This ticket's own first draft of the test above put the counted node reachable from only
ONE compiled group and asserted `constructions === 1` — that assertion is true whether or not
memoMap sharing works at all, because there was never a second construction site to duplicate it.
A counter test with no reachable failure mode is not a regression guard, it is a tautology dressed
as one. The correct shape (both this ticket's test and TKT-349's original) puts the SAME node
reachable from two SEPARATE `compile()` calls and asserts both directions: `=== 1` under a shared
MemoMap, `=== 2` under separate ones. Before trusting a construction-counter test, break the
mechanism it claims to guard on purpose and confirm the assertion actually fails — a test that
cannot go red is not evidence.

## Merge-blocking gates

These gates are **merge-blocking conditions**, not aspirations. A PR that trips one does not
merge until it passes, regardless of who wrote it or how much of the milestone it represents.

### The three stop/go gates (design and build posts)

1. **Lifecycle gate** — do not build UI features on session or project state until snapshot,
   event, reconnect, and tab-reconciliation tests pass with duplicate and reordered delivery.
2. **Agent-memory gate** — do not claim compaction reliability until repeated-compaction
   evaluations preserve exact constraints and the runner demonstrably reloads goal, ledger, and
   profile versions.
3. **Monitor gate** — do not expose Monitor over the web until durable ownership, permission
   parity, output redaction, restart recovery, cancellation, and authorization tests all pass.

### The four release gates (validation post)

1. **State gate** — snapshots, duplicate and reordered events, retries, reconnects, and
   two-window tests converge for session and project state.
2. **Data gate** — every supported historical fixture upgrades, restarts, remains readable, and
   passes the backup-restore drill; the purge inventory is complete.
3. **Agent gate** — repeated-compaction evaluations preserve exact active constraints and recover
   omitted details within deterministic context budgets.
4. **Background and client gate** — Monitor containment, authorization, crash recovery,
   real-browser lifecycle, and performance budgets pass on the supported platform matrix.

A milestone's PRs are free to land independently, but none of them may claim a gate is satisfied
on the strength of a green test suite alone — the validation post is explicit that no single green
suite proves the absence of regressions. Cite the specific evidence (fixture, crash matrix row,
differential test, telemetry threshold) the gate asks for.

## CI runner reality (read this before trusting `gh run list`)

**Actions is not "on" just because `actions/permissions` says `enabled: true`.** On this fork,
that flag was already `true` but `GET /repos/Draugur-AI/opencode/actions/workflows` returned
`total_count: 0` — GitHub had never indexed any of the 26 workflow files, so nothing could fire
regardless of triggers. Toggling the flag `false` then `true` again (`PUT
.../actions/permissions` with `-F enabled=false` then `-F enabled=true`) forced a re-index; after
that, `total_count` jumped to 26 and workflows started firing on PR events. **If a new PR shows
zero check-runs and it isn't a `CONFLICTING` mergeable state (see below), suspect un-indexed
workflows and try this toggle before anything else.**

A handful of workflows (`beta`, `close-issues`, `close-prs`, `compliance-close`, `docs-update`,
`stats`) came back in state `disabled_fork` even after indexing — GitHub still gates schedule/
release-shaped workflows on forks individually. None of those are part of the PR gate, so this
was not chased further.

**Most `runs-on:` values in this repo's workflows are `blacksmith-4vcpu-ubuntu-2404` /
`-windows-2025` (or an `-arm` variant).** Blacksmith is a hosted-runner *replacement* service
gated by a GitHub App install; `Draugur-AI` does not have it installed (`GET
/repos/Draugur-AI/opencode/actions/runners` and `GET orgs/Draugur-AI/actions/runners` both show
no self-hosted runners either). A job targeting a `blacksmith-*` label on this fork queues
forever — not a failure, not a timeout, just permanently `status: queued, conclusion: null`.
Confirmed empirically on a control PR: `typecheck`, `unit (linux)`, `unit (windows)`, `e2e
(linux)`, `e2e (windows)`, and `nix-eval` all sat `queued` for 15+ minutes while the two
`ubuntu-latest` jobs on the same PR (`check-standards`, `check-compliance` from
`pr-standards.yml`) completed within seconds. **A permanently-queued check on this fork is a
runner-label problem, not an infrastructure stall — check `runs-on:` before assuming Actions is
broken.**

**Also distinguish from the other known silent-failure mode**: a PR whose `mergeable` /
`mergeStateStatus` is `CONFLICTING` produces **zero** `pull_request`-triggered check-runs at all
(no merge ref gets built), which looks identical to an Actions outage. Always check
`gh pr view <n> --json mergeable,mergeStateStatus` before troubleshooting CI as if it were down.

## Self-hosted runner (TKT-338) and the fork-PR guard

This fork is **public**, and a self-hosted runner executes whatever a triggering workflow says.
That combination is the hazard: a `pull_request` event can originate from a fork whose head repo
differs from this one, and a permissive self-hosted runner would run that fork's code on our
host. Two independent mitigations, deliberately not just one:

1. **Repo Actions policy** (`GET/PUT
   /repos/Draugur-AI/opencode/actions/permissions/fork-pr-contributor-approval`, readable and
   writable with repo-admin, no org-admin needed despite appearances — verified during TKT-338
   after every other endpoint 403'd or came back empty): `approval_policy` set to
   `all_external_contributors`. An outside contributor's workflow run needs explicit approval
   before it executes at all.
2. **Per-job guard, in versioned YAML, auditable and greppable — the one that matters if (1) is
   ever misconfigured or silently reverted**: every job whose `runs-on` includes the
   `opencode-fork` self-hosted label carries
   `if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository`.
   Push events (`dev`) are internal by definition and always pass; a `pull_request` event only
   passes when the PR's head repo is this repo. A fork PR's `unit`/`e2e`/`typecheck` jobs
   therefore never reach the self-hosted runner at all — they simply don't run, rather than
   running unsafely. This is what makes the runner safe **by construction**, independent of any
   repo or org setting.

**The runner itself**: `opencode-fork-runner-1`, its own directory
(`~/actions-runner-opencode-fork`), labels `[self-hosted, opencode-fork, linux, arm64]`, a
systemd `--user` unit (not `sudo ./svc.sh install` — this host's NOPASSWD sudo is scoped to
`docker`/`ctr` only). Two other runners share this host: `spark-6703` (system-level unit,
`draugur-alpha`) and the flagship runner (TKT-337) — three distinct directories is what avoids
the two-`Runner.Listener`s-racing-one-`_temp` footgun that has bitten this host before (see
[[ci-runner-double-listener]]). **Windows is disabled**, not just left on GitHub-hosted: this
host is linux/aarch64, so `unit (windows)` and `e2e (windows)` are dropped from their workflow
matrices rather than burning GitHub-hosted minutes for a platform this runner can't serve.
Revisit when GH-hosted minutes reset or a Windows runner exists elsewhere.

## Does automated review run on fork PRs? — Yes, as of 2026-08-11.

**Superseded 2026-08-11 (TKT-323, feedback #191, PR #32).** The "No" answer below stood on real
evidence (no branch protection, no rulesets, `/review` non-functional) and misled nobody while it
was true — but it went stale the moment Sean funded GH Actions and enabled a Copilot Review
ruleset on this fork (id `20729187`, active, on the default branch), and it sat as a stale "No"
for one night before this update, which is its own lesson: a "does X run" answer needs to be
re-verified before being relied on, not just cited.

**Current state, confirmed by the mechanism's first real firing:** PR #32 (the readTarget
redaction reversal — itself a security fix) triggered an automatic Copilot review with **two
inline findings, both real, both fixed**:
1. A second, independent leak path in the same redaction logic PR #32 was fixing — `readTarget`'s
   secret-path lookup keyed off a `parsed` value that gets discarded on *any* unrelated JSONC
   diagnostic, so a config file with a syntax error elsewhere but a real mcp secret still leaked
   the secret in raw text.
2. `InvalidRequestError.field` set to a target ID (a value) instead of a stable field name,
   inconsistent with the convention used elsewhere in the handler layer.

Both were caught on the review's first live PR, before merge, on a security-sensitive diff our
own process had already run through the full `/work` §6/§10 validation pass. **This retires the
"treat review as absent" convention everywhere it was cited** (see "Not yet running…" note above,
§ "No automated review runs on fork PRs").

**Review process now:** Copilot review (automatic, runs on PR open and on every push to an open
PR) **plus** peer review, same as before — Copilot does not replace a human reviewer, it runs
alongside one, per `/work` §6.

**Caveat — the wrong-base footgun:** a branch cut from another feature branch (rather than from
`dev` directly) silently inherits that branch as its PR base unless `--base` is passed explicitly
at PR-open. A PR opened against the wrong base gets **no automated review** — the ruleset is
scoped to PRs targeting the default branch. Always pass `--base dev` explicitly when opening a PR
here, and confirm the review actually fired (not just that CI ran) before treating its silence as
a clean diff — an absent review on a wrong-based PR looks identical to an absent review on a
genuinely quiet one.

---

<details>
<summary>Original "No" finding, for the historical record (superseded above, evidence retained)</summary>

Answer, with evidence, for the (now superseded) "assume no review runs" convention:

1. **Nothing ran automatically on PR open**, as of this writing. There was no branch protection
   (`GET .../branches/dev/protection` → 404) and no rulesets (`GET .../rulesets` → `[]`) on this
   repo — unlike the workspace repo's Copilot-review ruleset. `.github/workflows/review.yml` was
   the only review-shaped workflow, and it triggered on `issue_comment: [created]` gated to
   comments starting with `/review` from an `OWNER`/`MEMBER` author — never on `pull_request`
   itself.
2. **`pr-standards.yml` and `pr-management.yml` are compliance bots, not code review.** They check
   PR title format (conventional-commit prefix), template-section presence, linked-issue
   presence, and duplicate-PR detection — labels and comments only, no line-level code
   feedback.
3. **Even the manual `/review` trigger was non-functional on this fork, for two independent
   reasons:**
   - Its job (`check-guidelines`) was `runs-on: blacksmith-4vcpu-ubuntu-2404` — same
     queued-forever problem as above.
   - `OPENCODE_API_KEY` (the secret the review step needs to actually invoke the opencode agent)
     was not configured on this repo.

Local per-package tests (the merge gate below) remain the primary quality gate; Copilot review is
now an additional layer on top, not a replacement for them.

</details>

## PR hygiene: the compliance bot and the 2-hour auto-close

`pr-standards.yml` labels a PR `needs:title` (bad title format) or `needs:compliance` (missing
`pull_request_template.md` sections, or fewer than 2 checked checklist boxes) and posts an
explanatory comment. `compliance-close.yml` runs every 30 minutes and **auto-closes** any PR still
labeled `needs:compliance` more than 2 hours after that comment — **unless the author is exempt**:
`opencode-agent[bot]`, anyone with `author_association` `OWNER`/`MEMBER`, or anyone listed in
`.github/TEAM_MEMBERS`.

**Our shared push credential (`sepo-eng`) has `author_association: MEMBER` on this repo** (verified
via `gh api repos/Draugur-AI/opencode/pulls/<n> --jq .author_association`), so **our PRs are
exempt from the 2-hour auto-close** — the cron job just strips the label and moves on. The
labels/comments still appear as cosmetic noise if the PR body doesn't match the template, so
**write PR bodies against `.github/pull_request_template.md`** (sections: `Issue for this PR`,
`Type of change`, `What does this PR do?`, `How did you verify your code works?`, `Checklist`
with ≥2 boxes checked) to avoid the noise, even though nothing will actually get closed.
Conventional-commit title prefixes (`feat|fix|docs|chore|refactor|test`, optionally
`(scope):`) avoid the `needs:title` label the same way. **Only `docs`/`refactor`/`feat` skip the
linked-issue requirement** — a `fix:`/`chore:`/`test:` title still needs `Closes #<number>` in the
body or the same bot flags it.

**Issues were disabled on this fork** (`has_issues: false`, discovered on TKT-349's PR #24 when
the linked-issue requirement above had nothing to link to) — re-enabled via `gh api
repos/Draugur-AI/opencode -X PATCH -F has_issues=true` (additive, reversible, our own fork). Until
the inherited `pr-standards.yml`/`compliance-close.yml` workflows are adjusted to not require one,
**every `fix:`/`chore:`/`test:` PR carries a linked shim issue**: title + one paragraph + a
cross-reference to the tracking ticket, with the issue body saying explicitly that it is a
compliance shim and the ticket is the source of truth. `Closes #<that issue>` in the PR body.

## The merge gate: all green, any red blocks

**As of TKT-336, this fork does not run a known-red-exceptions regime any more.** That regime
(below, kept as history) had a real cost: every merge had to re-confirm that CI's redness was
*only* the already-known kind, which burns effort on every single PR and creates exactly the
place a real regression can hide — "red" stopped being a reliable signal, because red was often
expected. The operator's directive (2026-08-10) was explicit: skip or fix the specific
known-failing things, with a comment and an un-skip/resolution condition, so that going forward
**any red on a clean PR is real** and does not need to be triaged against a table first.

The gate is now simply: **every gated check on the PR is green.** No named exceptions, no
dev-baseline comparison step, no "characterise before attributing" ritual. If a gated check
shows red, that is a signal to look at, not a lookup against this file.

**The gate is `typecheck` + `unit (linux)` + `unit (windows)` + `packages/opencode
test:httpapi`.** `check-standards` / `check-compliance` (PR hygiene) are separate, real signal
if labeled, but were never part of the test/build quality gate.

**Local-environment caveat, unchanged:** `packages/opencode/test/tool/write.test.ts` "sets file
permissions when writing sensitive data" asserts `0o644` and fails with `0o664` on a machine
whose umask is `002` (the shared dev box is one). CI's `ubuntu-latest` runner uses umask `022`
and passes it. That is the environment, not the code — do not chase it if you see it locally, and
it should not appear in CI.

**CI parity is now enforced at the unit level too (TKT-338):** `opencode-fork-runner-1`'s login
shell inherits this host's `002` umask, which surfaced the same failure deterministically on
every `unit (linux)` run once jobs started landing there. Fixed with `UMask=0022` on the
runner's systemd `--user` unit (`~/.config/systemd/user/actions-runner-opencode-fork.service`)
rather than touching the test — the environment was the thing lying about production umasks,
not the assertion. The caveat above still applies to a plain local `bun test` on this or any
`002`-umask box; it just no longer reaches CI.

## Observational checks (retargeted, running, deliberately NOT in the gate)

`e2e (linux)` and `e2e (windows)` (both, symmetrically) and `nix-eval` run on every PR but do not
block merge. This is a narrower, checkable version of the "advisory" status this fork abolished
for `unit`/`test:httpapi` in TKT-336 — advisory-without-a-rule is exactly how a real regression
hides (that was the whole reason for abolishing it), so each observational check gets a
**deterministic reading rule** instead of a judgment call:

- **e2e (`linux`) stays on GitHub-hosted (`ubuntu-latest`), not the self-hosted runner (TKT-338):**
  `bunx playwright install-deps chromium` needs `sudo apt-get install`, and this host's NOPASSWD
  sudo is scoped to `docker`/`ctr` only (confirmed via `sudo -n -l`) — most of the requested
  libs are already present, but 8 packages (`xvfb`, `fonts-unifont`, `xfonts-cyrillic`,
  `xfonts-scalable`, `fonts-ipafont-gothic`, `fonts-wqy-zenhei`, `fonts-tlwg-loma-otf`,
  `fonts-freefont-ttf`) are missing and the install fails with `sudo: a password is required`.
  Left on GitHub-hosted because e2e is observational, not the merge gate — the minutes worth
  reclaiming are `typecheck`/`unit (linux)`. Unlock condition: those 8 packages installed on
  the runner host (one-time, operator; the exact command is in TKT-338's diary), then retarget
  this matrix entry to `[self-hosted, opencode-fork, linux, arm64]` the same way
  `typecheck`/`unit (linux)` already are.
- **e2e (`packages/app`'s Playwright regression suite):** first ran on either platform in
  TKT-336 (previously queued forever on blacksmith on both) and turned out to have ordinary,
  pre-existing E2E flakiness — a small number of timing-sensitive specs occasionally fail past
  Playwright's own retries, on both `ubuntu-latest` and `windows-latest`, not a platform-specific
  gap (an earlier reading called this a Windows-only "~40 systemic failures"; that was a grep
  artifact counting Playwright's test-discovery listing, not real failures — corrected in
  feedback #156, real count was 2 failed / 87 passed on Windows, then 1 failed / 96 passed on a
  later Linux run, different spec each time). Stabilizing genuine E2E flakiness is a different
  body of work from CI hygiene — it belongs to the milestone-3 real-browser-matrix slice, not
  this ticket. **The rule: the SAME spec failing on 3 consecutive runs is a real regression, file
  it — no judgment required. Scattered single-spec flakes across different specs, run to run, are
  not.** This is checkable by anyone reading the last 3 runs' failure lists side by side; it does
  not require characterising *why* a test is flaky, only whether the *same* one keeps failing.
- **`unit (linux)`** (the actual merge gate, unlike observational `e2e` above) **can show the
  same scattered-flake shape, timer-correlated:** first seen on TKT-349's PR #24 — reruns of one
  unchanged commit repeatedly failed different, unrelated, timer-shaped specs
  (`observe-element-offset`'s `setTimeout(0)` assertion, `plugin.openai.ws-pool`'s idle-connection
  pruning timer, `ModelsDev Service`'s cache-fetch hitting its 30000ms timeout at 30000.20ms),
  none touching the PR's own diff. An earlier version of this entry proposed a "wait for host load
  under ~6" precondition before rerunning — **retracted**: checked directly, `load average ~9` is
  this host's *normal* operating state while two fleets work (vLLM inference serving both fleets,
  concurrent test/worker sessions), not a spike to wait out. A threshold set from one settling
  sample is the same unmeasured-threshold mistake as elsewhere in this ledger — don't repeat the
  shape even when the specific number looks plausible. **Corrected, bounded policy:** unit reruns
  take the host as it is, no load precondition — fire one rerun of the failed job whenever the
  runner is free. If a spec fails that has already failed in a **prior run of the same PR**
  (`plugin.openai.ws-pool` reached 3 failures across TKT-349's own reruns), treat it as
  known-flaky-under-normal-load: skip it with `test.skip` and a comment linking the deflake
  feedback item, and add a row to the "Resolved CI reds" table below (Sean's standing directive:
  cheaper to skip a particular known unit test with a comment than to keep re-running around it).
  A spec with only one failure across a PR's runs stays live — no skip on a single occurrence.
  Fix shape for whoever picks up hardening these: fake-clock (`bun:test`'s `setSystemTime`/a
  controlled timer, rather than a real `setTimeout`/timeout race), which removes the host-load
  dependency entirely instead of tolerating
  it.
- **`nix-eval`:** disabled (auto-trigger removed, see "Blacksmith runner sweep" below) rather
  than gated or merely observational — Nix packaging validity is not this fork's concern at all,
  so there is nothing to read a rule against.

There is still no branch protection configured on this repo, so none of the gate above is
mechanically enforced by GitHub itself — reviewers/mergers read the check-runs list by hand.

## Resolved CI reds (history, as of TKT-336)

Kept for anyone who hits the same symptom locally or reads an old PR's CI log — not because any
of these are still expected. Every row here was fixed, deliberately skipped, or (the e2e row)
moved out of the gate entirely once investigation showed the symptom wasn't what it first looked
like; nothing here is a currently-live gate exception.

| Symptom (as first observed, TKT-305) | Root cause | Resolution |
| --- | --- | --- |
| `unit (windows)` — a *varying subset* of unrelated `packages/core` tests (Ripgrep, i18n parity, Git worktrees/trees, LocationServiceMap, MoveSession), each failing at a uniform ~5000–5500ms | `packages/core`'s test script had **no `--timeout` override at all** — it ran on bun:test's raw 5000ms default, unlike `packages/opencode`/`packages/tui` which already used `--timeout 30000`. Confirmed by grep: every suite in the original failure list lives in `packages/core`. | **Fixed** (TKT-336): added `--timeout 30000` to `packages/core/package.json`'s `test` script, matching the fork's own established convention. Verified: every one of these suites passed on the next real CI run. |
| `unit (windows)` — `bun install --linker hoisted` intermittently fails applying the `@ai-sdk/openai-compatible@2.0.41` patch (`ENOTEMPTY`, matches [`oven-sh/bun#28147`](https://github.com/oven-sh/bun/issues/28147)) | An upstream bun patch-apply race, `ubuntu-latest` unaffected. | **Not independently resolved** — folded into the windows-unit-skip below (TKT-336) once a *different*, deterministic Windows failure (Ripgrep) meant the whole "Run unit tests" step needed skipping on Windows anyway. If Windows unit tests are ever re-enabled, re-verify this mode separately; it was never actually fixed on its own terms. |
| `unit (windows)` — Ripgrep (4 tests), *still* red after the timeout fix above, now timing out at exactly 30000ms instead of ~5000ms, `Ripgrep.Error: ripgrep execution failed` | A real, deterministic execution failure on `windows-latest`, not a timing margin issue — raising the timeout just gave it more rope before failing the same way. `RipgrepBinary`'s Windows path downloads a versioned zip and extracts it via PowerShell at first use (`packages/core/src/ripgrep/binary.ts`); the exact cause (network restriction, PowerShell invocation, path/quoting) is unconfirmed. | **Skipped** (TKT-336, feedback #152): the entire "Run unit tests" step in `test.yml`'s `unit` job is now `if: runner.os == 'Linux'` — this is the ticket's own stated fallback ("skip the windows unit job entirely... if timeouts alone do not stabilize it"), since the residual failure is a real bug requiring production-code investigation, out of scope for a CI-hygiene ticket. Un-skip condition: feedback #152 is root-caused and fixed. |
| `unit (linux)` — `run-process.test.ts`, "exits nonzero promptly when the model is unknown (regression for #27371)": `expect(result.durationMs).toBeLessThan(15_000)` reliably measures ~15.3s | The pattern (always just past the exact configured 15s timeout, not randomly distributed) suggests the "unknown model" fast-fail path is not triggering on GitHub Actions' network, and the process is instead killed by its own configured timeout. | **Skipped, not widened** (TKT-336, feedback #136): widening the assertion's threshold would mask this exact failure mode (a real fast-fail-not-triggering gap) instead of catching it, so `test.skip` was used directly rather than the shared `cliIt.concurrent` helper (which does not support `.skip` — see its own doc comment). Un-skip condition: feedback #136 is triaged. |
| `unit (linux)` — 7 additional `run-process.test.ts` tests, briefly, only on TKT-315's own PR: clustered 700-800ms over the harness's 30\_000ms default `timeoutMs` | TKT-315 added `ProjectV2.node`/`SessionGoal.node`/`SessionLedger.node` to `app-runtime.ts`'s CLI/TUI `AppLayer` (see "Adding a new global `.node`?" above — all three traced reachable, not removable). None do eager I/O, but building 3 more global nodes has nonzero per-process construction cost; invisible in isolated timing (8 runs each, branch vs. dev, fully overlapping) but real under `run-process.test.ts`'s 13 concurrent `cliIt.concurrent()` subprocess spawns (6x full-file runs, non-overlapping ranges). | **Interim `timeoutMs` widen shipped in the same PR** (30\_000 → 45\_000 on the 7 affected tests only, each commented, feedback #150) — the real fix (lazy node construction so a CLI invocation that never touches project/goal/ledger data pays nothing for them) is still open, tracked in #150. This is the one row here that is not fully closed — it is an accepted, narrow, linked interim, not a currently-observed red. |
| `packages/opencode test:httpapi`, `mode=effect` only — `v2.session.goal.get`, "a session with no goal set should report no data" | Was masked by a crash (see the `SessionGoal.node`/`SessionLedger.node` wiring gap above) until TKT-315 fixed the wiring and let the route's assertion actually run; the assertion itself then failed, a real bug in TKT-317's goal-get response path (filed as feedback #145). | **Fixed** ([#10](https://github.com/Draugur-AI/opencode/pull/10), Gemma) — confirmed dead on `dev@441ad185`: `test:httpapi --mode effect` went from 227/0 (crash-masked) to 226/1 (this assertion, post-TKT-315) to 229/0 (post-#10, three new scenarios added along the way, zero fail). No exception needed in the simplified gate above. |
| `e2e (windows)`, first run only — apparent ~40 `e2e/regression/*.spec.ts` failures | **Misread, not a real symptom** — the ~40 count was a grep artifact (spec-file-path occurrences anywhere in the log, which also matches Playwright's test-discovery listing) mistaken for a failure list. The real first-run result was 2 failed / 87 passed. A subsequent run showed `e2e (linux)` — clean on its first two runs — fail 1 spec too, a *different* spec. Both platforms show the same class of ordinary, low-rate E2E flakiness, pre-existing and simply never observed before (e2e never ran on either platform pre-TKT-336, both queued forever on blacksmith). | **Not a red to resolve — moved out of the gate entirely, symmetrically on both platforms** (Ethan's ruling: stabilizing genuine Playwright flakiness is a different body of work than CI hygiene, belongs to the milestone-3 real-browser-matrix slice). See "Observational checks" above for the deterministic reading rule that replaces the skip. Feedback #156 corrected in place rather than superseded — the correction is part of its own record. |
| `unit (linux)` — `plugin.openai.ws-pool`, "prunes idle websocket connections after completed responses" | Real `setTimeout`-based idle-connection-pruning race, timing-sensitive under normal host load (this host runs ~9 load average continuously serving two fleets' inference/tests — not a spike). Failed 3 times across TKT-349's own CI reruns of one unchanged commit, unrelated to that PR's diff. | **Skipped** (TKT-349, feedback #180): `test.skip` with a comment linking the feedback item. Un-skip condition: feedback #180 is triaged — fake-clock (`setSystemTime`/a controlled timer) replacing the real timer removes the flake at its root rather than just tolerating it. |
## Blacksmith runner sweep (TKT-336)

Beyond the two `unit`-job retargets TKT-305 already covered, the repo accumulated **18+
permanently-queued workflow runs** across every other workflow still targeting `blacksmith-*`
labels — one of them (`test.yml`'s `e2e` job) held its own workflow run open indefinitely,
which blocks `rerun-failed-jobs` for every job in that run, `unit` included. This is what
produced the "workflow already running" error when trying to rerun TKT-315's PR #8.

Every workflow file that referenced a `blacksmith-*` label was given one of four treatments,
each with its own comment at the point of change:

- **Retargeted** to a GitHub-hosted runner, because the check is real and wanted:
  `test.yml`'s `e2e` job (real Playwright coverage, and the direct held-open-run cause above),
  `storybook.yml` (path-filtered UI build check), `notify-discord.yml` (cheap, rarely fires).
- **Auto-trigger disabled**, `workflow_dispatch` kept as a manual escape hatch: `nix-eval.yml`,
  `nix-hashes.yml` (Nix packaging — not this fork's concern), `generate.yml` (auto-commits
  generated code back to whatever branch triggered it, unreviewed — conflicts with this fork's
  own manual-regenerate-in-a-reviewed-PR convention), `docs-update.yml`, `docs-locale-sync.yml`
  (docs sync — this fork is not the canonical docs source), `publish.yml`,
  `publish-github-action.yml`, `publish-vscode.yml`, `containers.yml`,
  `release-github-action.yml` (real publish pipelines with write credentials to npm, ghcr.io,
  the VS Code Marketplace, GitHub Releases — an internal architecture-redesign fork
  auto-publishing under the org's name on every push is a one-way mistake, not just a cost one),
  `beta.yml` (hourly cron — was the single largest contributor to the queued-run backlog,
  24/day, for a beta channel this fork does not maintain).
- **Job-level `if: false`** (or `false &&` prepended to a real condition, to keep it trivially
  revertible), because the job is double-blocked — runner *and* a missing secret, so retargeting
  the runner alone would just turn a silent queue into a visible failure on every trigger:
  `pr-management.yml`'s `check-duplicates` (fires on every PR open), `review.yml`'s
  `check-guidelines` (the `/review` trigger, already documented below), `opencode.yml`'s
  `opencode` job (the `/oc` `/opencode` trigger). All three need `OPENCODE_API_KEY`, which is
  not configured on this repo.
- **Untouched, already inert** — no runner-label fix would change anything: `duplicate-issues.yml`
  and `triage.yml` trigger on `issues:` events, and this repo has `has_issues: false`, so those
  events can never fire. `stats.yml` already self-excludes via
  `if: github.repository == 'anomalyco/opencode'`.

`pull_request_target`-triggered workflows (`pr-management.yml`) are evaluated by GitHub using the
workflow file **on the base branch**, not the PR branch, as a security measure against a
malicious PR modifying its own privileged workflow. A fix to one of these cannot be verified on
the PR that introduces it — only on PRs opened after it merges to `dev`.
