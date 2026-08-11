import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import { currentSession, type MockServerConfig } from "../utils/mock-server"
import { openWindow } from "../utils/two-window"

const SERVER = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const directory = "C:/OpenCode/ReconnectRace"
const projectID = "proj_reconnect_race"

const sessionEventFirst = { id: "ses_race_event_first", title: "Event arrives before snapshot" }
const sessionSnapshotFirst = { id: "ses_race_snapshot_first", title: "Snapshot arrives before event" }
const sessionStable = { id: "ses_race_stable", title: "Stays open" }

function baseConfig(): MockServerConfig {
  return {
    protocol: "v2",
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "reconnect-race",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [{ id: "opencode", name: "OpenCode", models: { "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } } } }],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [
      { ...sessionEventFirst, slug: sessionEventFirst.id, projectID, directory, version: "dev", time: { created: 1700000000000, updated: 1700000000000 } },
      { ...sessionSnapshotFirst, slug: sessionSnapshotFirst.id, projectID, directory, version: "dev", time: { created: 1700000000000, updated: 1700000000000 } },
      { ...sessionStable, slug: sessionStable.id, projectID, directory, version: "dev", time: { created: 1700000000000, updated: 1700000000000 } },
    ],
    pageMessages: () => ({ items: [] }),
  }
}

async function archive(page: Awaited<ReturnType<typeof openWindow>>["page"], sessionID: string, requestID: string) {
  await page.evaluate(
    async ({ SERVER, sessionID, requestID }) => {
      const response = await fetch(`${SERVER}/api/session/${sessionID}/archive`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestID }),
      })
      if (!response.ok) throw new Error(`archive failed: ${response.status}`)
    },
    { SERVER, sessionID, requestID },
  )
}

test("a reconnect snapshot and a live archive event racing in either order both converge to the tab closing", async ({
  browser,
}) => {
  const config = baseConfig()
  const window = await openWindow(browser, config, { server: SERVER })

  await window.page.addInitScript(
    ({ SERVER, sessionEventFirst, sessionSnapshotFirst, sessionStable }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([
          { type: "session", server: SERVER, sessionId: sessionEventFirst.id },
          { type: "session", server: SERVER, sessionId: sessionSnapshotFirst.id },
          { type: "session", server: SERVER, sessionId: sessionStable.id },
        ]),
      )
    },
    { SERVER, sessionEventFirst, sessionSnapshotFirst, sessionStable },
  )

  const href = (sessionID: string) => `/server/${base64Encode(SERVER)}/session/${sessionID}`
  await window.page.goto(href(sessionStable.id))

  const tabFor = (sessionID: string) => window.page.locator(`[data-titlebar-tab-slot]:has(a[href="${href(sessionID)}"])`)
  await expect(tabFor(sessionEventFirst.id)).toBeVisible()
  await expect(tabFor(sessionSnapshotFirst.id)).toBeVisible()
  await expect(tabFor(sessionStable.id)).toBeVisible()
  const initialConnection = await window.transport.waitForConnection()

  // The connection drops (network blip, laptop sleep -- same trigger as sleep-resume.spec.ts) so
  // neither archive below is seen live; only the reconnect's own snapshot can catch them up.
  await window.transport.disconnect()

  // Archive BOTH sessions on the shared mock while this page cannot see either happen yet.
  await archive(window.page, sessionEventFirst.id, "race-archive-event-first")
  await archive(window.page, sessionSnapshotFirst.id, "race-archive-snapshot-first")

  // --- Ordering 1: the live event is delivered before the reconnect's own snapshot resolves ---
  // `runSnapshot()` fires fire-and-forget on `server.connected` (session-entities-sync.tsx never
  // awaits it inline), so a `session.updated` sent on the same fresh connection right after
  // reconnecting can genuinely land before that fetch's response does.
  const snapshotResponse = window.page.waitForResponse(
    (res) => res.url().includes("lifecycle=all") && res.request().method() === "GET",
  )
  const reconnected = await window.transport.waitForConnection({ after: initialConnection.id })
  const eventFirstSession = config.sessions.find((session) => session.id === sessionEventFirst.id)!
  await window.transport.send({
    directory,
    payload: { type: "session.updated", properties: { info: currentSession(eventFirstSession, directory) } },
  })
  await snapshotResponse

  await expect(tabFor(sessionEventFirst.id)).toHaveCount(0)
  await expect(tabFor(sessionStable.id)).toBeVisible()

  // --- Ordering 2: the reconnect's own snapshot resolves, and only afterwards does a live event
  // for the SAME already-archived session also arrive (e.g. a redundant re-delivery). Reconcile
  // must not double-navigate or resurrect anything on the second, now-redundant pass. ---
  await expect(tabFor(sessionSnapshotFirst.id)).toHaveCount(0)
  const snapshotFirstSession = config.sessions.find((session) => session.id === sessionSnapshotFirst.id)!
  await window.transport.send({
    directory,
    payload: { type: "session.updated", properties: { info: currentSession(snapshotFirstSession, directory) } },
  })
  await expect(tabFor(sessionSnapshotFirst.id)).toHaveCount(0)
  await expect(tabFor(sessionStable.id)).toBeVisible()
  await expect(window.page).toHaveURL(new RegExp(`/session/${sessionStable.id}$`))

  // Both removals are durable, not just DOM-visible for this instance.
  await window.page.reload()
  await expect(tabFor(sessionEventFirst.id)).toHaveCount(0)
  await expect(tabFor(sessionSnapshotFirst.id)).toHaveCount(0)
  await expect(tabFor(sessionStable.id)).toBeVisible()
  void reconnected
})
