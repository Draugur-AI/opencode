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
| Context-retention evaluation harness: new `@opencode-ai/eval` package — a scripted-model V2 app-graph builder, a per-instance fake `LLMClient.Service` capturing every composed `LLMRequest`, injected/real compaction epoch drivers, restart-survival via `Database.layerFromPath` reopen, per-source token/byte accounting, and two fixtures (omitted-identifier-recovery, constraint-survival) run in both real and pre-slice-4-approximation (`Layer.mock` on `SessionGoal`/`SessionLedger.context()`) modes, with a `bun run gate` CLI report ([#12](https://github.com/Draugur-AI/opencode/pull/12), PR1 of 2 — PR2 adds the real second-binary/real-model release gate) | Upstream has no outcome-evaluation harness for compaction reliability at all, and the design/validation posts are explicit that schema/service tests passing is not evidence the agent actually retains anything — "score decisions, not summary resemblance." Design post, "Context-retention evaluation"; validation post, "Agent reliability requires outcome evaluations" | not yet filed | none — pure new tooling package, no schema/table changes | none | **keep** — this harness is fork-specific by construction (it tests `SessionGoal`/`SessionLedger`/history-search, none of which exist upstream); it stays fork-only even if the domains it tests eventually get proposed upstream |

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
- **No automated review runs on fork PRs** (see "Does automated review run on fork PRs?" below —
  confirmed, with evidence, as of TKT-305). Say so explicitly in every PR and report — local
  per-package tests are the gate, and an absence of review comments is not evidence of a clean diff.

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

## Does automated review run on fork PRs? — No.

Answer, with evidence, for the standing "assume no review runs" convention already baked into
every ticket in this tree:

1. **Nothing runs automatically on PR open.** There is no branch protection (`GET
   .../branches/dev/protection` → 404) and no rulesets (`GET .../rulesets` → `[]`) on this repo —
   unlike the workspace repo's Copilot-review ruleset. `.github/workflows/review.yml` is the only
   review-shaped workflow, and it triggers on `issue_comment: [created]` gated to comments
   starting with `/review` from an `OWNER`/`MEMBER` author — never on `pull_request` itself.
2. **`pr-standards.yml` and `pr-management.yml` are compliance bots, not code review.** They check
   PR title format (conventional-commit prefix), template-section presence, linked-issue
   presence, and duplicate-PR detection — labels and comments only, no line-level code
   feedback.
3. **Even the manual `/review` trigger is currently non-functional on this fork, for two
   independent reasons:**
   - Its job (`check-guidelines`) is `runs-on: blacksmith-4vcpu-ubuntu-2404` — same queued-forever
     problem as above. **Left un-retargeted deliberately**: fixing the runner alone would not
     make it work (see next point), and provisioning secrets is not a worker-level fix.
   - `OPENCODE_API_KEY` (the secret the review step needs to actually invoke the opencode agent)
     is not configured on this repo — `gh secret list --repo Draugur-AI/opencode` and `gh
     variable list --repo Draugur-AI/opencode` both return empty. The step would fail on
     missing credentials even if the runner picked it up.

**Conclusion: treat review as absent on every fork PR, full stop, exactly as the standing
per-ticket convention already says.** Local per-package tests (the merge gate below) are
the actual quality gate. If `/review` is ever wanted, it needs both a runner-label fix (same
one-line pattern as `typecheck.yml`) *and* an operator-provisioned `OPENCODE_API_KEY` secret —
neither is done here.

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

## Observational checks (retargeted, running, deliberately NOT in the gate)

`e2e (linux)` and `e2e (windows)` (both, symmetrically) and `nix-eval` run on every PR but do not
block merge. This is a narrower, checkable version of the "advisory" status this fork abolished
for `unit`/`test:httpapi` in TKT-336 — advisory-without-a-rule is exactly how a real regression
hides (that was the whole reason for abolishing it), so each observational check gets a
**deterministic reading rule** instead of a judgment call:

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
