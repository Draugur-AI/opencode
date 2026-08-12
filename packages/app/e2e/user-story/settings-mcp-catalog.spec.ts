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
  // but they are two different fields, asserted separately so a future change can't silently
  // collapse "the user disabled it" into "the live status happens to also say disabled".
  const parkedRow = list.locator(".settings-v2-mcp-row", { hasText: "parked" })
  await expect(parkedRow).toContainText("disabled")

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
