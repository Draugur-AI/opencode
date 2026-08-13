import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/ShellSlowResource"

const project = {
  id: "proj_shell_slow_resource",
  worktree: directory,
  vcs: "git" as const,
  name: "ShellSlowResource",
  time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
  sandboxes: [],
}

const session = {
  id: "ses_shell_slow_resource",
  title: "Shell slow resource session",
  directory,
  time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
}

// TKT-411 (feedback #202): createShellSettingsController's `shells` resource has
// `initialValue: []`, but `shells.latest` could still read as non-array before general.tsx's
// ShellSetting consumed it -- `input.shells.reduce` then threw inside createShellOptions, and
// the app-root ErrorBoundary (app.tsx) swallowed the whole window, not just the dialog.
//
// What THIS test pins down, verified with a fresh dev server per configuration (delete-the-fix
// on general-controllers.ts alone, mock-server.ts unchanged, still passes -- so this test does
// not by itself prove a timing-dependent second cause): mock-server.ts modeled
// `/api/pty/shells`, but sdk.client.pty.shells() calls the real bare V1 endpoint `/pty/shells`
// -- every request fell through to the fixture's generic fallback, which returns a bare `{}`,
// not caught by `?? []`. Not timing-dependent, not racy: a normal flow (wait for the app to be
// visible, then open settings) crashed identically to firing the shortcut immediately on
// navigation. Fixed at the source (mock-server.ts).
//
// general-controllers.ts's own guard (`Array.isArray(...) ? ... : []` at the fetcher, `?? []`
// at the controller's return) is kept as a reasoned defensive improvement -- prefer
// unrepresentable per the ticket's own fix shape, and a malformed or slow-to-resolve response
// is not something a real server is proven incapable of -- but that guard's necessity is not
// demonstrated by a red/green in this file; only the mock-server.ts fix is.
test("opening settings does not crash the whole window on a malformed shells response", async ({ page }) => {
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(String(error)))

  await mockOpenCodeServer(page, {
    directory,
    project,
    provider: () => ({ all: [], connected: [], default: undefined }),
    sessions: [session],
    pageMessages: () => ({ items: [] }),
  })

  await page.goto(`/${base64Encode(directory)}/session/${session.id}`)
  await expectAppVisible(page.locator('[data-component="prompt-input-v2"]'))
  await page.keyboard.press("Control+,")
  await page.waitForTimeout(1500)

  expect(pageErrors).toEqual([])
  await expect(page.getByText("Something went wrong")).not.toBeVisible()

  const dialog = page.locator(".settings-v2-dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('[data-action="settings-shell"]')).toBeVisible()
})
