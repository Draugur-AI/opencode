import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

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
// `initialValue: []`, but `shells.latest` can still read as non-array before general.tsx's
// ShellSetting consumes it -- `input.shells.reduce` then throws inside createShellOptions, and
// the app-root ErrorBoundary (app.tsx) swallows the whole window, not just the dialog. Two
// distinct causes were behind this, both fixed:
// 1. mock-server.ts's own bug (not timing at all, 100% deterministic): it modeled
//    `/api/pty/shells`, but sdk.client.pty.shells() calls the real bare V1 endpoint
//    `/pty/shells` -- every request fell through to the fixture's generic fallback, which
//    returns a bare `{}`, not caught by `?? []`. Fixed at the source (mock-server.ts).
// 2. A genuine timing race, independent of (1) -- confirmed by delete-the-fix with (1) already
//    fixed: opening the dialog before the app finishes its own startup still crashes. Reproduced
//    here by firing Control+, immediately on navigation, before waiting for the app to report
//    ready. Nothing about a slow session/provider mount on a real server is specific to this
//    fixture, so guarded at the controller (general-controllers.ts), not just patched here.
test("opening settings before the app finishes its own startup does not crash the whole window", async ({
  page,
}) => {
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
  // Fire immediately -- no expectAppVisible wait. This is the race: the settings dialog (and
  // createShellSettingsController's resource inside it) mounts before the app's own startup has
  // settled, the same window feedback #202 caught.
  await page.keyboard.press("Control+,")
  await page.waitForTimeout(1500)

  expect(pageErrors).toEqual([])
  await expect(page.getByText("Something went wrong")).not.toBeVisible()

  const dialog = page.locator(".settings-v2-dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('[data-action="settings-shell"]')).toBeVisible()
})
