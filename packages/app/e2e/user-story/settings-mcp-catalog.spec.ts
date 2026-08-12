import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import type { Page, Route } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/McpCatalog"

const project = {
  id: "proj_mcp_catalog",
  worktree: directory,
  vcs: "git" as const,
  name: "McpCatalog",
  time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
  sandboxes: [],
}

const session = {
  id: "ses_mcp_catalog",
  title: "MCP catalog session",
  directory,
  time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
}

function jsonRoute(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
}

/**
 * `/api/mcp` and `/api/mcp/status` aren't in the shared mock-server fixture (it only knows the
 * legacy `/mcp` shape -- see mock-server.ts's `emptyObject` set). Registering these AFTER
 * mockOpenCodeServer's catch-all means they run first (Playwright routes are LIFO) without
 * touching the shared fixture other regression specs depend on -- same pattern as
 * `home-project-favorites.spec.ts`'s `mockProjectInventory`.
 */
async function mockMcp(page: Page, opts: { catalog: unknown[]; status: unknown | { unavailable: true } }) {
  // Trailing `*` is load-bearing: mcp.list/mcp.status always send a `location[directory]=...`
  // query string, so an unqualified `**/api/mcp` pattern never matches the real request and
  // silently falls through to mockOpenCodeServer's own hardcoded empty `/api/mcp` response --
  // same convention as `**/api/path?*` (session-list-path-loading.spec.ts) and `**/api/pty*`
  // (terminal-*.spec.ts). `/api/mcp*` and `/api/mcp/status*` never collide: `*` cannot match `/`,
  // so `/api/mcp*` cannot match the `/status` path segment.
  await page.route("**/api/mcp/status*", async (route) => {
    if (opts.status && typeof opts.status === "object" && "unavailable" in opts.status) {
      return jsonRoute(
        route,
        { _tag: "ServiceUnavailableError", message: "No live MCP runtime in this assembly", service: "mcp.status" },
        503,
      )
    }
    return jsonRoute(route, {
      location: { directory, project: { id: project.id, directory } },
      data: opts.status,
    })
  })
  await page.route("**/api/mcp*", async (route) => {
    return jsonRoute(route, {
      location: { directory, project: { id: project.id, directory } },
      data: opts.catalog,
    })
  })
}

async function openMcpTab(page: Page) {
  await page.goto(`/${base64Encode(directory)}/session/${session.id}`)
  await expectAppVisible(page.locator('[data-component="prompt-input-v2"]'))
  await page.keyboard.press("Control+,")
  const dialog = page.locator(".settings-v2-dialog")
  await expect(dialog).toBeVisible()
  await dialog.getByRole("tab", { name: "MCP" }).click()
  return dialog
}

test("MCP tab shows live status per server, distinct from the static catalog", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project,
    provider: () => ({ all: [], connected: [], default: undefined }),
    sessions: [session],
    pageMessages: () => ({ items: [] }),
  })
  await mockMcp(page, {
    catalog: [
      { name: "discord", transport: "local", status: "configured", target: "project:opencode.json" },
      { name: "sentry", transport: "remote", status: "configured", target: "project:opencode.json" },
      { name: "parked", transport: "local", status: "disabled", target: "project:opencode.json" },
    ],
    status: {
      discord: { status: "connected" },
      sentry: { status: "failed", error: "connection refused" },
      parked: { status: "disabled" },
    },
  })

  const dialog = await openMcpTab(page)
  const list = dialog.locator('[data-component="settings-v2-list"]')

  const discordRow = list.locator(".settings-v2-mcp-row", { hasText: "discord" })
  await expect(discordRow).toContainText("connected")

  const sentryRow = list.locator(".settings-v2-mcp-row", { hasText: "sentry" })
  await expect(sentryRow).toContainText("failed")
  await expect(sentryRow).toContainText("connection refused")

  // The catalog's own static status ("disabled") is a Tag, and the live status agrees here --
  // but they are two different fields. Asserted against each element independently (Copilot
  // review, PR #36: a single toContainText("disabled") on the whole row would still pass if a
  // regression collapsed the two into one element) so a future change can't silently collapse
  // "the user disabled it" into "the live status happens to also say disabled".
  const parkedRow = list.locator(".settings-v2-mcp-row", { hasText: "parked" })
  await expect(parkedRow.locator(".settings-v2-mcp-main")).toContainText("disabled")
  await expect(parkedRow.locator(".settings-v2-mcp-status-label")).toHaveText("disabled")

  await expect(dialog.locator('[data-component="mcp-runtime-unavailable"]')).toHaveCount(0)
})

test("MCP tab renders a truthful unavailable state when no live runtime exists, never a fabricated status", async ({
  page,
}) => {
  await mockOpenCodeServer(page, {
    directory,
    project,
    provider: () => ({ all: [], connected: [], default: undefined }),
    sessions: [session],
    pageMessages: () => ({ items: [] }),
  })
  await mockMcp(page, {
    catalog: [{ name: "discord", transport: "local", status: "configured", target: "project:opencode.json" }],
    status: { unavailable: true },
  })

  const dialog = await openMcpTab(page)
  await expect(dialog.locator('[data-component="mcp-runtime-unavailable"]')).toBeVisible()

  // The catalog itself (static config) still renders -- unavailable live status must not hide
  // configuration the user can see and edit.
  const list = dialog.locator('[data-component="settings-v2-list"]')
  const discordRow = list.locator(".settings-v2-mcp-row", { hasText: "discord" })
  await expect(discordRow).toBeVisible()

  // Never a fabricated "connected"/"failed"/"disabled" claim when the runtime is absent.
  await expect(discordRow).not.toContainText("connected")
  await expect(discordRow).not.toContainText("failed")
})

test("MCP tab surfaces a catalog fetch failure distinctly, never as a silent empty state", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project,
    provider: () => ({ all: [], connected: [], default: undefined }),
    sessions: [session],
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/api/mcp*", (route) => {
    if (route.request().url().includes("/status")) return route.fallback()
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "boom" }) })
  })

  const dialog = await openMcpTab(page)
  await expect(dialog.locator('[data-component="settings-v2-list"]')).toContainText("Request failed")
  // Distinct from the genuinely-empty-catalog message -- a reader must be able to tell "the
  // fetch broke" apart from "there is nothing configured here".
  await expect(dialog.locator('[data-component="settings-v2-list"]')).not.toContainText("No MCPs configured")
})

const targetID = "project:e2e-target"

/**
 * Mocks the config-document surface (target list/read/apply) the add/edit/remove dialogs drive.
 * The real secret-preserving MERGE logic lives server-side (packages/core/src/config/document.ts,
 * covered by its own delete-the-fix unit tests) -- this mock always succeeds and just records
 * every applied patch, so what this spec actually proves is the CLIENT wiring: does the dialog
 * send the right sequence of patches for what the user typed, not whether the server merges them
 * correctly (a different layer, already proven elsewhere).
 */
function mockConfigDocument(page: Page, opts: { existingText?: string; existingParsed?: unknown }) {
  const applied: unknown[] = []
  let hash = "hash-0"
  page.route("**/api/config/document/target**", async (route) => {
    // `**` (not a single trailing `*`) is load-bearing here for a DIFFERENT reason than the
    // pathname-vs-full-url footgun below: a single `*` cannot cross a `/`, so it matches the bare
    // `target` (list) path but never `target/<id>` or `target/<id>/apply` -- every targetRead/
    // targetApply call would silently fall through unmocked. `**` matches across `/` the same way
    // the leading `**` already does.
    //
    // `.pathname`, not the raw URL string -- every one of these requests carries a
    // `?location[directory]=...` query string, so `url.endsWith(...)`/`url.includes(...)` against
    // the FULL url is the same query-string footgun already found and fixed once in this file for
    // /api/mcp*. Stripping to pathname first is what makes exact-suffix matching safe here.
    const pathname = new URL(route.request().url()).pathname
    const method = route.request().method()
    if (pathname === "/api/config/document/target" && method === "GET") {
      return jsonRoute(route, {
        location: { directory, project: { id: project.id, directory } },
        data: [{ id: targetID, kind: "project", path: "opencode.json", exists: true }],
      })
    }
    if (pathname === `/api/config/document/target/${encodeURIComponent(targetID)}/apply`) {
      const body = route.request().postDataJSON() as { expectedHash: string; patch: unknown }
      applied.push(body.patch)
      hash = `hash-${applied.length}`
      return jsonRoute(route, { location: { directory, project: { id: project.id, directory } }, data: { hash, restartImpact: "restart" } })
    }
    if (pathname === `/api/config/document/target/${encodeURIComponent(targetID)}` && method === "GET") {
      return jsonRoute(route, {
        location: { directory, project: { id: project.id, directory } },
        data: {
          target: { id: targetID, kind: "project", path: "opencode.json", exists: true },
          text: opts.existingText ?? "{}",
          hash,
          parsed: opts.existingParsed ?? {},
          diagnostics: [],
        },
      })
    }
    return route.fallback()
  })
  return { applied: () => applied }
}

test("Add server dialog sends a set patch, then one credential.set per filled-in credential", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project,
    provider: () => ({ all: [], connected: [], default: undefined }),
    sessions: [session],
    pageMessages: () => ({ items: [] }),
  })
  await mockMcp(page, { catalog: [], status: {} })
  const config = mockConfigDocument(page, {})

  const dialog = await openMcpTab(page)
  await dialog.getByRole("button", { name: "Add server" }).click()

  const form = page.locator(".settings-v2-server-dialog")
  await expect(form).toBeVisible()
  await form.locator('input[type="text"]').first().fill("discord")
  // Type defaults to local -- fill command + one credential.
  await form.getByPlaceholder("npx some-mcp-server").fill("npx discord-mcp")
  await form.getByRole("button", { name: "Add" }).click()
  const credentialRow = form.locator(".settings-v2-mcp-credential-row").first()
  await credentialRow.locator("input").first().fill("API_KEY")
  await credentialRow.locator("input").last().fill("sk-e2e-secret")
  await form.getByRole("button", { name: "Save" }).click()

  await expect(form).toHaveCount(0)
  expect(config.applied()).toEqual([
    { op: "mcp.server.set", name: "discord", value: { type: "local", command: ["npx", "discord-mcp"] } },
    {
      op: "mcp.server.credential.set",
      name: "discord",
      key: { field: "environment", key: "API_KEY" },
      value: "sk-e2e-secret",
    },
  ])
})

test("Edit dialog: leaving an existing credential blank sends no credential patch for it", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project,
    provider: () => ({ all: [], connected: [], default: undefined }),
    sessions: [session],
    pageMessages: () => ({ items: [] }),
  })
  await mockMcp(page, {
    catalog: [{ name: "discord", transport: "local", status: "configured", target: targetID }],
    status: { discord: { status: "connected" } },
  })
  const config = mockConfigDocument(page, {
    existingParsed: {
      mcp: {
        servers: {
          discord: { type: "local", command: ["old-command"], environment: { API_KEY: "[redacted]" } },
        },
      },
    },
  })

  const dialog = await openMcpTab(page)
  const row = dialog.locator(".settings-v2-mcp-row", { hasText: "discord" })
  await row.getByLabel("Edit").click()

  const form = page.locator(".settings-v2-server-dialog")
  await expect(form).toBeVisible()
  // Name is locked in edit mode, prefilled from the catalog entry.
  await expect(form.locator('input[type="text"]').first()).toHaveValue("discord")
  await expect(form.getByPlaceholder("npx some-mcp-server")).toHaveValue("old-command")
  // The existing credential shows as a row (key visible) with no value prefilled.
  const credentialRow = form.locator(".settings-v2-mcp-credential-row").first()
  await expect(credentialRow.locator("input").first()).toHaveValue("API_KEY")
  await expect(credentialRow.locator("input").last()).toHaveValue("")

  await form.getByPlaceholder("npx some-mcp-server").fill("new-command")
  await form.getByRole("button", { name: "Save" }).click()

  await expect(form).toHaveCount(0)
  // Only the connection-detail patch -- the untouched, blank credential row produces NOTHING,
  // never a credential.set with an empty string. This is the client-side half of the same
  // "editing preserves what it didn't touch" property the core-level merge tests prove server-side.
  expect(config.applied()).toEqual([
    { op: "mcp.server.set", name: "discord", value: { type: "local", command: ["new-command"] } },
  ])
})

test("Remove confirmation sends a remove patch for the right server", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project,
    provider: () => ({ all: [], connected: [], default: undefined }),
    sessions: [session],
    pageMessages: () => ({ items: [] }),
  })
  await mockMcp(page, {
    catalog: [{ name: "discord", transport: "local", status: "configured", target: targetID }],
    status: { discord: { status: "connected" } },
  })
  const config = mockConfigDocument(page, {})

  const dialog = await openMcpTab(page)
  const row = dialog.locator(".settings-v2-mcp-row", { hasText: "discord" })
  await row.getByLabel("Remove").click()

  const confirm = page.getByText("Remove discord?")
  await expect(confirm).toBeVisible()
  // Keyboard activation, not a mouse click: a pre-existing, unrelated crash (General tab's
  // shell-settings resource -- filed as feedback, not TKT-323's concern) fires on every
  // settings-v2 dialog open in this mock environment, confirmed present immediately after
  // openMcpTab, before any MCP interaction at all. It leaves a real, coordinate-hit-testable
  // overlay remnant on top of this dialog's screen position (Add/Edit's larger forms happen not
  // to overlap it) -- `click({ force: true })` was tried and silently hit that overlay instead
  // (it dismissed the dialog without ever sending the remove patch, caught by the applied-patch
  // assertion below). Focusing the real button and activating it via keyboard sidesteps
  // coordinate hit-testing entirely, so it can't land on the wrong element.
  await page.getByRole("button", { name: "Remove", exact: true }).focus()
  await page.keyboard.press("Enter")

  await expect(confirm).toHaveCount(0)
  expect(config.applied()).toEqual([{ op: "mcp.server.remove", name: "discord" }])
})
