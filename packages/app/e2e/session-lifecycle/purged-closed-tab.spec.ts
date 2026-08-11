import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import type { MockServerConfig } from "../utils/mock-server"
import { openWindow } from "../utils/two-window"

const SERVER = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const directory = "C:/OpenCode/PurgedClosedTab"
const projectID = "proj_purged_closed_tab"

const sessionClosed = { id: "ses_purged_closed", title: "Closed then purged" }
const sessionStable = { id: "ses_purged_stable", title: "Stays open" }

function baseConfig(): MockServerConfig {
  return {
    protocol: "v2",
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "purged-closed-tab",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [{ id: "opencode", name: "OpenCode", models: { "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } } } }],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [
      { ...sessionClosed, slug: sessionClosed.id, projectID, directory, version: "dev", time: { created: 1700000000000, updated: 1700000000000 } },
      { ...sessionStable, slug: sessionStable.id, projectID, directory, version: "dev", time: { created: 1700000000000, updated: 1700000000000 } },
    ],
    pageMessages: () => ({ items: [] }),
  }
}

test("purging a session drops it from the recently-closed stack so reopening cannot resurrect a tombstone", async ({
  browser,
}) => {
  const config = baseConfig()
  const window = await openWindow(browser, config, { server: SERVER })

  await window.page.addInitScript(
    ({ SERVER, sessionClosed, sessionStable }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([
          { type: "session", server: SERVER, sessionId: sessionClosed.id },
          { type: "session", server: SERVER, sessionId: sessionStable.id },
        ]),
      )
    },
    { SERVER, sessionClosed, sessionStable },
  )

  const href = (sessionID: string) => `/server/${base64Encode(SERVER)}/session/${sessionID}`
  await window.page.goto(href(sessionClosed.id))

  const tabClosed = window.page.locator(`[data-titlebar-tab-slot]:has(a[href="${href(sessionClosed.id)}"])`)
  await expect(tabClosed).toBeVisible()
  await window.transport.waitForConnection()

  // The user closes the tab themselves -- this is the ordinary close path (tabs.tsx's
  // `removeTab`), NOT reconcile. It lands on the recently-closed stack so "reopen closed tab"
  // can bring it back, same as any other closed tab.
  await tabClosed.locator('[data-slot="tab-close"] button').click()
  await expect(tabClosed).toHaveCount(0)

  const closedStack = () =>
    window.page.evaluate(() => localStorage.getItem("opencode.window.browser.dat:tabs.closed"))
  await expect.poll(closedStack).toContain(sessionClosed.id)

  // The server permanently deletes the session the closed tab pointed at -- a real purge, not an
  // archive/trash detour. `session.deleted` is the only event a purge produces (there is no
  // dedicated "purged" event; V2 reuses the V1 delete event name).
  await window.page.evaluate(
    async ({ SERVER, sessionID }) => {
      const response = await fetch(`${SERVER}/api/session/${sessionID}/purge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestID: "purged-closed-tab-1", confirmation: sessionID }),
      })
      if (!response.ok) throw new Error(`purge failed: ${response.status}`)
    },
    { SERVER, sessionID: sessionClosed.id },
  )
  await window.transport.send({
    directory,
    payload: { type: "session.deleted", properties: { sessionID: sessionClosed.id } },
  })

  // forgetClosed() (session-entities.ts) is what tabs.reconcile() checks before letting a purged
  // reference survive on the closed stack -- this is the one place that predicate is exercised
  // end to end rather than just in the reducer's own unit tests.
  await expect.poll(closedStack).not.toContain(sessionClosed.id)

  // Durable across reload, and the OTHER tab is untouched by any of this.
  await window.page.reload()
  await expect.poll(closedStack).not.toContain(sessionClosed.id)
  await expect(
    window.page.locator(`[data-titlebar-tab-slot]:has(a[href="${href(sessionStable.id)}"])`),
  ).toBeVisible()
})
