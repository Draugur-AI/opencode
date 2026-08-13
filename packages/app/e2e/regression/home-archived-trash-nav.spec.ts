import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

/**
 * Feedback 173: /archived and /trash were reachable only by typing the URL. The affordance is
 * the point, so this clicks the links rather than asserting they exist -- an element that is
 * present but not clickable would satisfy the weaker check and still leave the views
 * unreachable.
 *
 * HomeUtilityNav renders twice, `hidden lg:flex` beside the projects list and `flex lg:hidden`
 * at the bottom for narrow viewports. The viewport below is wide enough for the first, and the
 * locators resolve the visible one so the assertion cannot pass against the hidden copy.
 */

const directory = "C:/OpenCode/HomeArchivedTrashNav"

test.use({ viewport: { width: 1280, height: 800 } })

test("reaches Archived and Trash from the home navigation", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_home_archived_trash_nav",
      worktree: directory,
      vcs: "git",
      name: "home-archived-trash-nav",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(
    ({ directory }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
    },
    { directory },
  )

  await page.goto("/")

  const archived = page.locator('[data-nav="archived"]:visible')
  await expect(archived).toHaveCount(1)
  await archived.click()
  await expect(page).toHaveURL(/\/archived$/)
  await expect(page.getByRole("heading", { name: "Archived" })).toBeVisible()

  await page.goBack()

  const trash = page.locator('[data-nav="trash"]:visible')
  await expect(trash).toHaveCount(1)
  await trash.click()
  await expect(page).toHaveURL(/\/trash$/)
  await expect(page.getByRole("heading", { name: "Trash" })).toBeVisible()
})
