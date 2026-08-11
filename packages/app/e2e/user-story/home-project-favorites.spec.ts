import { expect, test } from "@playwright/test"
import type { Page, Route } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

type Preference = {
  projectID: string
  favorite: boolean
  hidden: boolean
  revision: number
}

const project = (id: string, name: string) => ({
  id,
  worktree: `/opencode-demo/${name}`,
  vcs: "git" as const,
  name,
  time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
  sandboxes: [],
})

/**
 * TKT-315's v2 project.list/preference routes aren't in the shared mock-server fixture yet
 * (it still serves the pre-v2 raw-array `/api/project` shape). Registering these AFTER
 * mockOpenCodeServer's catch-all means they run first (Playwright routes are LIFO) without
 * touching the shared fixture other regression specs depend on.
 */
async function mockProjectInventory(page: Page, projects: ReturnType<typeof project>[]) {
  const preferences = new Map<string, Preference>(
    projects.map((p) => [p.id, { projectID: p.id, favorite: false, hidden: false, revision: 0 }]),
  )
  const respond = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(body),
    })

  await page.route("**/api/project", (route) => {
    if (route.request().method() !== "GET") return route.fallback()
    respond(route, { data: projects })
  })
  await page.route(/\/api\/project\/[^/]+\/preference$/, (route) => {
    const projectID = new URL(route.request().url()).pathname.split("/").at(-2)!
    const current = preferences.get(projectID) ?? { projectID, favorite: false, hidden: false, revision: 0 }
    if (route.request().method() === "GET") return respond(route, { data: current })
    if (route.request().method() === "PATCH") {
      const patch = route.request().postDataJSON() as Partial<Preference> & { expectedRevision?: number }
      const expected = patch.expectedRevision ?? 0
      if (expected !== current.revision) {
        return respond(
          route,
          {
            _tag: "ProjectPreferenceConflictError",
            projectID,
            revision: current.revision,
            message: `Preference revision conflict for project ${projectID}: currently at ${current.revision}`,
          },
          409,
        )
      }
      const next: Preference = { ...current, ...patch, revision: current.revision + 1 }
      preferences.set(projectID, next)
      return respond(route, { data: next })
    }
    route.fallback()
  })

  return preferences
}

async function openHome(page: Page, projects: ReturnType<typeof project>[]) {
  await mockOpenCodeServer(page, {
    protocol: "v2",
    sessions: fixture.sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
    fileList: () => [],
    findFiles: () => [],
  })
  const preferences = await mockProjectInventory(page, projects)
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
  })
  await page.goto("/")
  const allTab = page.getByRole("tab", { name: "All" })
  await expectAppVisible(allTab)
  return { preferences, allTab }
}

test("toggles a project's favorite, and it survives a reload", async ({ page }) => {
  const projects = [project("prj_alpha", "alpha"), project("prj_beta", "beta")]
  const { allTab } = await openHome(page, projects)

  await allTab.click()
  const alphaRow = page.locator('[data-project-id="prj_alpha"]')
  await expect(alphaRow).toBeVisible()

  await alphaRow.locator('[data-action="home-inventory-favorite"]').click()

  const favoritesTab = page.getByRole("tab", { name: "Favorites" })
  await favoritesTab.click()
  await expect(page.locator('[data-project-id="prj_alpha"]')).toBeVisible()
  await expect(page.locator('[data-project-id="prj_beta"]')).toHaveCount(0)

  // The regression this guards: a `useQueries` observer whose own queryFn re-fetches its own
  // query key deadlocks silently, so a favorite would read back as unset after a fresh load
  // even though the server has it persisted (TKT-315 diary, 2026-08-11).
  await page.reload()
  await expect(page.getByRole("tab", { name: "All" })).toBeVisible()
  await page.getByRole("tab", { name: "Favorites" }).click()
  await expect(page.locator('[data-project-id="prj_alpha"]')).toBeVisible()
})

test("renders a large project inventory without a network round-trip per row", async ({ page }) => {
  const projects = Array.from({ length: 300 }, (_, i) => project(`prj_${i}`, `project-${i}`))
  const { allTab } = await openHome(page, projects)

  const start = Date.now()
  await allTab.click()
  await expect(page.locator('[data-component="home-inventory-row"]')).toHaveCount(300)
  const renderMs = Date.now() - start

  const domNodeCount = await page.evaluate(() => document.querySelectorAll("*").length)
  console.log(`[perf] 300-project All tab: render+settle ${renderMs}ms, ${domNodeCount} DOM nodes`)
  expect(renderMs).toBeLessThan(5000)
})
