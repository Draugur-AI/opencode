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
| `unit (windows)` | `bun install --linker hoisted` fails applying the `@ai-sdk/openai-compatible@2.0.41` patch | `error: renaming changes to cache dir: ENOTEMPTY: ... Directory not empty (NtSetInformationFile())` — matches the exact race described in [`oven-sh/bun#28147`](https://github.com/oven-sh/bun/issues/28147), which the workflow's own `bun install --linker hoisted` comment already references. Identical failure on 2/2 independent reruns. `ubuntu-latest` is unaffected. | feedback #136 (internal tracker) | Resolves when bun's patch-apply race is fixed upstream, or worked around (e.g. serialize patch application on Windows, or pin an unaffected bun patch-apply path). |
| `unit (linux)` | `packages/opencode/test/cli/run/run-process.test.ts:79` — "exits nonzero promptly when the model is unknown (regression for #27371)" | `expect(result.durationMs).toBeLessThan(15_000)` received `15285ms` then `15275ms` on two independent reruns — consistently ~275–285ms *over* the `timeoutMs: 15_000` configured two lines above the assertion. The pattern (always just past the exact configured timeout, not randomly distributed) suggests the "unknown model" fast-fail path is not triggering on GitHub Actions' network, and the process is instead being killed by its own `timeoutMs` — which structurally cannot finish before the timeout it races against. Not exercised by TKT-304's local baseline (that baseline ran `packages/core test` + `packages/opencode test:httpapi` + `packages/app test` specifically, not `packages/opencode`'s own broader suite that `bun turbo test` pulls in). | feedback #136 (internal tracker) | Resolves when #136 is triaged — either the fast-fail detection is fixed, or the test's timing assumption is loosened for CI network conditions. |

## The milestone-1 required gate

Per TKT-304's local baseline (all green at pinned `0bff28de`, zero pre-existing reds in that
scope) and the runner fix above, the **documented milestone-1 merge gate** is:

- `typecheck` check **green** (GitHub-hosted, `bun typecheck` — schema/core/protocol/server/app)
- the local `core`/`httpapi`/`app` suites **green**, exactly as TKT-304 baselined them
  (`packages/core test`, `packages/opencode test:httpapi`, `packages/app test`)

The full `unit (linux)`/`unit (windows)` CI jobs (which run the broader `bun turbo test` across
every package, a wider surface than TKT-304's baseline) are **advisory** until
feedback #136 (internal tracker) resolves — one known-red test on each platform (table above) means
those jobs cannot be treated as a hard gate yet without also blocking on a pre-existing,
unrelated defect. `check-standards` / `check-compliance` (PR hygiene) are real signal if labeled,
but not a quality gate.

Not yet part of the functional gate at all (documented above, not silently broken): `e2e
(linux/windows)`, `nix-eval`, `/review`. There is no branch protection configured, so none of
this is mechanically enforced yet — reviewers/mergers should read the check-runs list by hand
until that's set up.
