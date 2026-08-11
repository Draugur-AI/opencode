import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import type { MockServerConfig } from "../utils/mock-server"
import { openWindow } from "../utils/two-window"

const SERVER = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const directory = "C:/OpenCode/SleepResume"
const projectID = "proj_sleep_resume"

const sessionWatched = { id: "ses_sleep_watched", title: "Watched while asleep" }
const sessionStable = { id: "ses_sleep_stable", title: "Stays open" }

function baseConfig(): MockServerConfig {
  return {
    protocol: "v2",
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "sleep-resume",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [{ id: "opencode", name: "OpenCode", models: { "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } } } }],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [
      { ...sessionWatched, slug: sessionWatched.id, projectID, directory, version: "dev", time: { created: 1700000000000, updated: 1700000000000 } },
      { ...sessionStable, slug: sessionStable.id, projectID, directory, version: "dev", time: { created: 1700000000000, updated: 1700000000000 } },
    ],
    pageMessages: () => ({ items: [] }),
  }
}

test("a session archived while the SSE connection was down (laptop asleep) closes its tab on reconnect", async ({
  browser,
}) => {
  const config = baseConfig()
  const window = await openWindow(browser, config, { server: SERVER })

  await window.page.addInitScript(
    ({ SERVER, sessionWatched, sessionStable }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([
          { type: "session", server: SERVER, sessionId: sessionWatched.id },
          { type: "session", server: SERVER, sessionId: sessionStable.id },
        ]),
      )
    },
    { SERVER, sessionWatched, sessionStable },
  )

  const href = (sessionID: string) => `/server/${base64Encode(SERVER)}/session/${sessionID}`
  await window.page.goto(href(sessionStable.id))

  const tabWatched = window.page.locator(`[data-titlebar-tab-slot]:has(a[href="${href(sessionWatched.id)}"])`)
  const tabStable = window.page.locator(`[data-titlebar-tab-slot]:has(a[href="${href(sessionStable.id)}"])`)
  await expect(tabWatched).toBeVisible()
  await expect(tabStable).toBeVisible()
  const initialConnection = await window.transport.waitForConnection()

  // The laptop sleeps: the SSE connection drops. No live event reaches this page from here on --
  // this is the whole point of the journey. tabSurvives() keeps an `unavailable` tab exactly for
  // this reason (session-entities.ts: "closing tabs because a laptop slept is the bug here").
  await window.transport.disconnect()

  // While asleep, a THIRD client archives the watched session directly against the shared mock
  // state -- no event fires here to tell this page, since its connection is down.
  await window.page.evaluate(
    async ({ SERVER, sessionID }) => {
      const response = await fetch(`${SERVER}/api/session/${sessionID}/archive`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestID: "sleep-resume-archive-1" }),
      })
      if (!response.ok) throw new Error(`archive failed: ${response.status}`)
    },
    { SERVER, sessionID: sessionWatched.id },
  )

  // The tab must NOT have moved yet -- nothing told this page anything happened.
  await expect(tabWatched).toBeVisible()

  // The laptop wakes: a fresh fetch to the event endpoint reconnects, and sse-transport.ts's own
  // mock emits a synthetic `server.connected` frame on every new connection (matching the real
  // server) -- session-entities-sync.tsx's `everConnected` flag treats a SECOND `server.connected`
  // as a reconnect and re-runs `runSnapshot()`, which is what should catch this session up.
  // `after` filters on connection ID (a sequence counter), not a timestamp -- the ID of the
  // connection that just dropped is exactly the threshold for "the next, genuinely new one."
  await window.transport.waitForConnection({ after: initialConnection.id, timeout: 15000 })

  await expect(tabWatched).toHaveCount(0)
  await expect(tabStable).toBeVisible()

  // Durable across a real reload too, not just this instance's DOM.
  await window.page.reload()
  await expect(tabWatched).toHaveCount(0)
  await expect(tabStable).toBeVisible()
})
