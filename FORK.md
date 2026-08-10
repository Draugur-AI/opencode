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
it never does I/O — see the eager-construction note in the milestone-1 gate section below
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
   regardless of runtime. Listing them here has a real, measured cost — see feedback #150 in the
   milestone-1 gate section below.
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
per-ticket convention already says.** Local per-package tests (the milestone-1 gate below) are
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

## Known-red CI jobs (as of TKT-305)

Turning CI on for the first time on this fork surfaced real, pre-existing, **deterministic**
failures unrelated to the CI-enablement change itself (confirmed by rerunning each once — both
reproduced identically). Filed as feedback rather than fixed here, since neither is in scope for
"CI and automated review on fork PRs." **Read this before assuming a red `unit` job on your PR is
your own regression** — check whether it matches one of these first.

| CI job | Failing test | Evidence | Feedback | Resolution condition |
| --- | --- | --- | --- | --- |
| `unit (windows)` — **mode A, the common one** | A *varying subset of unrelated tests*, each failing at a uniform ~5000–5500ms | Not one test and not one cause. Three runs, failure sets by name: `dev@bd772dd3` (zero fork changes, the control) → `Ripgrep` ×4; `2e8d972` → `i18n parity` ×4, `Git worktrees`, `Git trees`, `LocationServiceMap`, `MoveSession` ×3; and Ripgrep *passed* in that third run. Suites that cannot share a cause (i18n string parity and git worktree creation do not interact) failing at an identical ~5s ceiling is the signature of a contended or underpowered runner hitting a per-test timeout — suspected to be `windows-latest` being smaller than the Blacksmith 4vcpu size upstream tunes these timeouts for. **The control run is the load-bearing evidence: `dev` fails this way with no fork code at all.** | feedback (internal tracker) — characterisation is future work, not scoped to any milestone-1 slice | Resolves when the flake is characterised: either the runner is sized up, or the per-test timeout is raised for Windows, or the affected suites are made timeout-independent. |
| `unit (windows)` — **mode B, intermittent** | `bun install --linker hoisted` fails applying the `@ai-sdk/openai-compatible@2.0.41` patch | `error: renaming changes to cache dir: ENOTEMPTY: ... Directory not empty (NtSetInformationFile())` — matches the exact race described in [`oven-sh/bun#28147`](https://github.com/oven-sh/bun/issues/28147), which the workflow's own `bun install --linker hoisted` comment already references. Identical failure on 2/2 independent reruns at the time it was recorded. `ubuntu-latest` is unaffected. Listed alongside mode A rather than replaced by it: this mode is real and was observed, it simply is not the only way Windows goes red, and in later runs install succeeded and the job reached the tests instead. | feedback #136 (internal tracker) | Resolves when bun's patch-apply race is fixed upstream, or worked around (e.g. serialize patch application on Windows, or pin an unaffected bun patch-apply path). |
| `unit (linux)` | `packages/opencode/test/cli/run/run-process.test.ts:79` — "exits nonzero promptly when the model is unknown (regression for #27371)" | `expect(result.durationMs).toBeLessThan(15_000)` received `15285ms` then `15275ms` on two independent reruns — consistently ~275–285ms *over* the `timeoutMs: 15_000` configured two lines above the assertion. The pattern (always just past the exact configured timeout, not randomly distributed) suggests the "unknown model" fast-fail path is not triggering on GitHub Actions' network, and the process is instead being killed by its own `timeoutMs` — which structurally cannot finish before the timeout it races against. Not exercised by TKT-304's local baseline (that baseline ran `packages/core test` + `packages/opencode test:httpapi` + `packages/app test` specifically, not `packages/opencode`'s own broader suite that `bun turbo test` pulls in). | feedback #136 (internal tracker) | Resolves when #136 is triaged — either the fast-fail detection is fixed, or the test's timing assumption is loosened for CI network conditions. |
| `packages/opencode test:httpapi` — **`mode=effect` only** | `GET /api/session/{sessionID}/goal` — `v2.session.goal.get` — "a session with no goal set should report no data" | Was masked by a crash: `session.goal`/`session.ledger` routes 500'd with "Service not found" on every mode, because the app's `LayerNode.group` in `packages/opencode/src/server/routes/instance/httpapi/server.ts` never listed `SessionGoal.node`/`SessionLedger.node` (a gap in [#7](https://github.com/Draugur-AI/opencode/pull/7), fixed standalone once found while working TKT-315). Fixing that crash let this route reach its own assertion, which fails only in `mode=effect` — `mode=coverage` and `mode=auth` both pass. Confirmed deterministic across reruns. | feedback #145 (internal tracker) | Resolves when #145 is triaged against TKT-317's own code — not a node-wiring issue, the route runs now, its behavior is wrong. |
| `unit (linux)` — **run-process under load, MITIGATED not currently red** | Up to 7 additional tests in `packages/opencode/test/cli/run/run-process.test.ts`, all clustered 700-800ms over the harness's 30\_000ms default `timeoutMs` (e.g. 30740-30800ms) | TKT-315 added `ProjectV2.node`/`SessionGoal.node`/`SessionLedger.node` to `app-runtime.ts`'s `AppLayer` (see "Adding a new global `.node`?" above -- all three traced reachable, not removable). None of the three do eager I/O at layer construction, but building 3 more global nodes has nonzero cost, and `run-process.test.ts` spawns 13 real CLI subprocesses concurrently (`cliIt.concurrent`) -- isolated single-test timing showed no difference between branches (8 runs each, fully overlapping), but 6x full-file runs did: dev-baseline [11.23s-11.69s] vs the branch with these 3 nodes [11.73s-11.91s], non-overlapping. Invisible locally (this machine has headroom the CI runners don't); on CI this plausibly tips several already-borderline subprocess spawns over their timeout at once. A CI rerun of the pre-fix commit came back fully clean (0 fail) on one attempt, so the failure is a mix of this real overhead and environmental variance, not 100% deterministic either way. Interim mitigation landed in the same PR: `timeoutMs` raised from 30\_000 to 45\_000 (and the outer test timeout to match) on the 7 affected tests only, each commented and linked here -- the real fix is lazy node construction, not a rider on a feature PR. | feedback #150 (internal tracker) | Resolves when #150 is triaged and global nodes construct lazily on first use instead of eagerly at `AppLayer` boot; the `timeoutMs` widen reverts once that lands. |

## The milestone-1 required gate

The **documented milestone-1 merge gate** is:

- `typecheck` check **green** (GitHub-hosted, `bun typecheck` — schema/core/protocol/server/app)
- `packages/core` suite **green** (`bun test --cwd packages/core`)
- `packages/app` suite **green** (`bun run --cwd packages/app test` — unit and browser)
- the **full** `packages/opencode` suite **green** (`bun test --cwd packages/opencode`), with
  exactly the two known-reds in the table above as named exceptions and nothing else
- `packages/opencode test:httpapi` **green** in `mode=coverage` and `mode=auth`; in `mode=effect`,
  green except for the one named exception in the table above (`v2.session.goal.get`, feedback
  #145). Kept named because CI runs it as a distinct step and because it fails the build on any
  route with no scenario — a property the broader suite does not have

On the CI `unit` jobs specifically:

1. **`unit (linux)`** — reds must be exactly the documented `run-process` timeout, and nothing else.
2. **`unit (windows)`** — a named exception **in full**, until mode A above is characterised. It is
   not a signal either way today.
3. 🛑 **Any Windows failure is compared against a dev-baseline run before being attributed to a
   PR.** One API call stands between a real regression and a shrug:
   `gh api "repos/Draugur-AI/opencode/commits/<dev-sha>/check-runs"`, then read the failing test
   *names* out of the job log and diff them against the PR's. This clause exists because a merge
   condition of "windows reds exactly the documented ones" was briefly in force and **`dev` itself
   could not meet it** — a condition the mainline fails is not a gate, it is a lockout. Writing the
   comparison down rather than leaving it to whoever happens to be careful is the whole point.

**Nothing in this gate is "advisory".** A check is either in the gate, or it has a named, linked
exception in the known-red table. That rule replaces an earlier scoping of this gate to TKT-304's
baseline command list, which was narrower than the code it was gating: the baseline ran
`test:httpapi` (215 route scenarios) but never `packages/opencode`'s own suite (~3280 tests), and
**three real regressions shipped into that gap** on [#4](https://github.com/Draugur-AI/opencode/pull/4)
— a public-wire-type count assertion, and a V1 contract regression where the archive adapter
discarded the caller's timestamp and answered with a wall-clock instant instead. All three were
invisible to the gate as written and were caught only because the then-advisory `unit` jobs were
read anyway. The same narrowness shows up twice more: the `unit (linux)` known-red below, and
`bun run lint` (1 pre-existing error, ~4859 warnings) which no baseline command covered either.

`check-standards` / `check-compliance` (PR hygiene) are real signal if labeled, but not a quality
gate.

**Local-environment caveat:** `packages/opencode/test/tool/write.test.ts` "sets file permissions
when writing sensitive data" asserts `0o644` and fails with `0o664` on a machine whose umask is
`002` (the shared dev box is one). CI's `ubuntu-latest` runner uses umask `022` and passes it.
That is the environment, not the code — do not chase it, and do not add it to the known-red table.

Not yet part of the functional gate at all (documented above, not silently broken): `e2e
(linux/windows)`, `nix-eval`, `/review`. There is no branch protection configured, so none of
this is mechanically enforced yet — reviewers/mergers should read the check-runs list by hand
until that's set up.
