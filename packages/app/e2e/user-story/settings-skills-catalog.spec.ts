import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import type { Page, Route } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/SkillCatalog"

const project = {
  id: "proj_skill_catalog",
  worktree: directory,
  vcs: "git" as const,
  name: "SkillCatalog",
  time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
  sandboxes: [],
}

const session = {
  id: "ses_skill_catalog",
  title: "Skill catalog session",
  directory,
  time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
}

function jsonRoute(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
}

/**
 * Dedicated mock rather than relying on the shared `mockOpenCodeServer` fixture's `/skill`
 * fallback (`emptyList`, a bare V1-style path, not the v2 `/api/skill` route) -- unclear whether
 * it actually covers the catalog route, and every request here carries a
 * `?location[directory]=...` query string, so a bare pattern anchored only on the catalog path
 * segment would never match anyway (the exact footgun already hit twice in
 * settings-mcp-catalog.spec.ts: a single trailing wildcard cannot cross a `/`, and a route
 * registered AFTER `mockOpenCodeServer`'s catch-all runs FIRST, not last -- Playwright routes are
 * LIFO, so registering after it is what makes this override safe).
 */
async function mockSkillCatalog(page: Page, entries: unknown[]) {
  await page.route("**/api/skill/catalog**", async (route) => {
    return jsonRoute(route, { location: { directory, project: { id: project.id, directory } }, data: entries })
  })
}

async function openSkillsTab(page: Page) {
  await page.goto(`/${base64Encode(directory)}/session/${session.id}`)
  await expectAppVisible(page.locator('[data-component="prompt-input-v2"]'))
  await page.keyboard.press("Control+,")
  const dialog = page.locator(".settings-v2-dialog")
  await expect(dialog).toBeVisible()
  await dialog.getByRole("tab", { name: "Skills" }).click()
  return dialog
}

function skillEntry(name: string, opts: Partial<{ description: string; slash: boolean; shadowed: boolean }> = {}) {
  return {
    skill: { name, description: opts.description, slash: opts.slash, location: `/skills/${name}/SKILL.md`, content: "# " + name },
    source: { type: "directory", path: "/project/.opencode/skill" },
    sourceIndex: 0,
    shadowedBy: opts.shadowed
      ? { source: { type: "directory", path: "/project/skill" }, sourceIndex: 1 }
      : undefined,
    target: "project:e2e-target",
  }
}

test("Skills tab lists the effective catalog, distinct source and slash indicators", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project,
    provider: () => ({ all: [], connected: [], default: undefined }),
    sessions: [session],
    pageMessages: () => ({ items: [] }),
  })
  await mockSkillCatalog(page, [
    skillEntry("deploy", { description: "Deploy to production", slash: true }),
    skillEntry("review", { description: "Review a PR" }),
  ])

  const dialog = await openSkillsTab(page)
  const list = dialog.locator('[data-component="settings-v2-list"]')

  const deployRow = list.locator(".settings-v2-skill-row", { hasText: "deploy" })
  await expect(deployRow).toContainText("Deploy to production")
  await expect(deployRow).toContainText("slash")

  const reviewRow = list.locator(".settings-v2-skill-row", { hasText: "review" })
  await expect(reviewRow).toContainText("Review a PR")
  await expect(reviewRow).not.toContainText("slash")
})

test("Skills tab marks a shadowed entry distinctly, never hiding it", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project,
    provider: () => ({ all: [], connected: [], default: undefined }),
    sessions: [session],
    pageMessages: () => ({ items: [] }),
  })
  await mockSkillCatalog(page, [
    skillEntry("review", { description: "Global default", shadowed: true }),
    { ...skillEntry("review", { description: "Project override" }), sourceIndex: 1 },
  ])

  const dialog = await openSkillsTab(page)
  const list = dialog.locator('[data-component="settings-v2-list"]')
  const rows = list.locator(".settings-v2-skill-row", { hasText: "review" })

  await expect(rows).toHaveCount(2)
  // Winner (no shadowedBy) sorts first, per the tab's own ordering (winners before shadowed).
  await expect(rows.nth(0)).toContainText("Project override")
  await expect(rows.nth(0)).not.toContainText("shadowed")
  await expect(rows.nth(1)).toContainText("Global default")
  await expect(rows.nth(1)).toContainText("shadowed")
})

test("Skills tab surfaces a catalog fetch failure distinctly, never as a silent empty state", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project,
    provider: () => ({ all: [], connected: [], default: undefined }),
    sessions: [session],
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/api/skill/catalog**", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "boom" }) }),
  )

  const dialog = await openSkillsTab(page)
  await expect(dialog.locator('[data-component="settings-v2-list"]')).toContainText("Request failed")
  await expect(dialog.locator('[data-component="settings-v2-list"]')).not.toContainText("No skills configured")
})
