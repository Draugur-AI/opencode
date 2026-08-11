# TKT-328 salvage — do not merge

This branch is **parked design input**, not a candidate. It is the abandoned first attempt at
migrating `packages/app` + `packages/session-ui` off the vendored client, kept so the next
attempt starts from evidence instead of rediscovering it.

## What is here

- `client-types.ts` — the named alias layer, probe-verified against real generated identifiers.
  This part is **sound and reusable**: it recovers the grouped API objects (`SessionApi`, …) and
  the entity types (`SessionInfo`, `FileDiffInfo`, …) by indexed access from operation-scoped
  generated types. Three names had to be corrected against the generator rather than guessed:
  `SessionActiveOutput → SessionsActiveOutput`, `IntegrationOauthConnectOutput →
  IntegrationsConnectOauthOutput`, and `Project → ServerProjectGetOutput["data"]` — that last one
  breaks the pluralisation pattern every other group follows, so it will catch the next person too.
- The import codemod applied across 42 files (`@opencode-ai/client/promise` → the real client,
  the alias layer, or `@opencode-ai/client-legacy/promise` for the MCP surface).
- `package.json` repins: `@opencode-ai/client` → `workspace:*`, `@opencode-ai/client-legacy` →
  the vendored tarball for MCP only, `client-next` retired.

## Why it stopped

The import rewrite is mechanical. What it exposes is not: **534 type errors across 34 files**,
because the two client generations differ semantically, not just in naming.

| Count | Class | What it means |
| --- | --- | --- |
| 267 | `TS2339` property-does-not-exist, mostly **on type `never`** | the generated event/message unions changed shape, so the app's exhaustive switches collapse to `never` (141 × `.data`, 24 × `.created`, plus `.id`/`.type`/`.metadata`) |
| 92 | `TS7006` implicit any | callbacks that inferred from the old types now infer from nothing |
| 36 | `TS2551` | group names went singular → plural: `client.integration` → `integrations`, `session` → `sessions` |
| 32 + 20 | `TS2678`, `TS2367` | `switch` cases and comparisons against event-type string literals that no longer exist |
| 30 | `TS2305` | names not exported at all under any spelling |
| ~10 | `TS2322`/`TS2345` | readonly-vs-mutable array variance, and dropped input fields (`SessionsListInput` has no `parentID`) |

Each class needs a **decision**, not a rename: what the event union is now called and whether the
app's switches remain exhaustive against it; whether readonly arrays are copied or accepted at the
call sites; what replaces a dropped input field.

## The reframe this produced

534 semantic differences is plausibly **why upstream vendored the tarball at all** — their app is
written against frozen shapes because their own generator moved underneath it. The two vendoring
commits have empty bodies and state no reason; this is the first mechanism anyone has found that
explains them.

That inverts the usual calculus: the bounded two-client wart is **cheaper to carry** than the
migration is to perform, at least until an upstream sync shows their own convergence.

## Retirement

The real migration is a design pass, not a mechanical ticket. The table above is its requirements
list.
