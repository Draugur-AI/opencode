import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import { currentSession, type MockServerConfig } from "../utils/mock-server"
import { openWindow } from "../utils/two-window"

const SERVER = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const directory = "C:/OpenCode/TwoWindow"
const projectID = "proj_two_window"

const sessionArchived = { id: "ses_two_window_archived", title: "Archived from elsewhere" }
const sessionStable = { id: "ses_two_window_stable", title: "Stays open" }

function baseConfig(): MockServerConfig {
  return {
    protocol: "v2",
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "two-window",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [{ id: "opencode", name: "OpenCode", models: { "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } } } }],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    // A genuinely mutable array: mock-server.ts's lifecycle POST handlers push/splice this array
    // in place, and both windows below share this SAME reference -- see two-window.ts.
    sessions: [
      { ...sessionArchived, slug: sessionArchived.id, projectID, directory, version: "dev", time: { created: 1700000000000, updated: 1700000000000 } },
      { ...sessionStable, slug: sessionStable.id, projectID, directory, version: "dev", time: { created: 1700000000000, updated: 1700000000000 } },
    ],
    pageMessages: () => ({ items: [] }),
  }
}

test("archiving a session from one window closes its tab in a second window watching the same session", async ({
  browser,
}) => {
  const config = baseConfig()
  const windowA = await openWindow(browser, config, { server: SERVER })
  const windowB = await openWindow(browser, config, { server: SERVER })

  for (const window of [windowA, windowB]) {
    await window.page.addInitScript(
      ({ SERVER, sessionArchived, sessionStable }) => {
        localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
        localStorage.setItem(
          "opencode.window.browser.dat:tabs",
          JSON.stringify([
            { type: "session", server: SERVER, sessionId: sessionArchived.id },
            { type: "session", server: SERVER, sessionId: sessionStable.id },
          ]),
        )
      },
      { SERVER, sessionArchived, sessionStable },
    )
  }

  const href = (sessionID: string) => `/server/${base64Encode(SERVER)}/session/${sessionID}`
  await windowA.page.goto(href(sessionArchived.id))
  await windowB.page.goto(href(sessionArchived.id))

  const tabArchived = (page: (typeof windowA)["page"]) =>
    page.locator(`[data-titlebar-tab-slot]:has(a[href="${href(sessionArchived.id)}"])`)
  const tabStable = (page: (typeof windowA)["page"]) =>
    page.locator(`[data-titlebar-tab-slot]:has(a[href="${href(sessionStable.id)}"])`)

  await expect(tabArchived(windowA.page)).toBeVisible()
  await expect(tabArchived(windowB.page)).toBeVisible()
  await windowA.transport.waitForConnection()
  await windowB.transport.waitForConnection()

  // Neither window archived it -- a third client (or the real server, on a schedule) did. This
  // mutates the ONE shared `config.sessions` array both windows' mock route handlers read from,
  // matching how a real server's committed lifecycle row is visible to every connected client.
  await windowA.page.evaluate(
    async ({ SERVER, sessionID }) => {
      const response = await fetch(`${SERVER}/api/session/${sessionID}/archive`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestID: "two-window-archive-1" }),
      })
      if (!response.ok) throw new Error(`archive failed: ${response.status}`)
    },
    { SERVER, sessionID: sessionArchived.id },
  )

  // A real `session.updated` event carries the full V1-shaped session (packages/core/src/
  // session/lifecycle.ts's `toRow()` mirrors the lifecycle state into `time.archived` for this
  // exact compatibility listener) -- `server-session.ts`'s own `session.updated` handler reads
  // `info.time.archived` unconditionally, so a stub `{id}` payload throws there instead of the
  // reconcile path ever running. `config.sessions` already reflects the mutation from the fetch
  // above (same array both windows' mock closures share), so build the event from it rather than
  // hand-authoring a second copy that could drift from what the archive endpoint actually wrote.
  const archivedSession = config.sessions.find((session) => session.id === sessionArchived.id)!
  const info = currentSession(archivedSession, directory)

  // Each window is its own SSE connection (see two-window.ts) -- the test stands in for the real
  // server's fan-out to every connected client.
  for (const window of [windowA, windowB]) {
    await window.transport.send({
      directory,
      payload: { type: "session.updated", properties: { info } },
    })
  }

  await expect(tabArchived(windowA.page)).toHaveCount(0)
  await expect(tabArchived(windowB.page)).toHaveCount(0)
  await expect(tabStable(windowA.page)).toBeVisible()
  await expect(tabStable(windowB.page)).toBeVisible()
  // Reconcile's own navigation (to the tab it selected after closing the doomed one) must settle
  // before this test drives its OWN navigation, or the two race for the URL.
  await expect(windowA.page).toHaveURL(new RegExp(`/session/${sessionStable.id}$`))
  await expect(windowB.page).toHaveURL(new RegExp(`/session/${sessionStable.id}$`))

  // The removal must be DURABLE, not just visible in the DOM for this instance: a re-resolving
  // route effect for the just-archived session (packages/app/src/pages/session.tsx's
  // `ResolvedTargetSessionRoute`) previously re-added this exact tab a moment after reconcile
  // removed it, which a DOM-only assertion above would not have caught -- only a fresh reload
  // reading the actually-persisted list proves the tab stays gone.
  await windowA.page.reload()
  await expect(tabArchived(windowA.page)).toHaveCount(0)
  await expect(tabStable(windowA.page)).toBeVisible()

  // Archived-view rendering itself is not a two-window concern (it's the same code path
  // regardless of which window asks), so this closes the loop on ONE window rather than paying
  // for a second full cold-boot: mutation -> SSE -> reconcile closes the tab -> the view built on
  // the SAME entity store shows the session that tab pointed at.
  await windowA.page.goto("/archived")
  await expect(windowA.page.getByText(sessionArchived.title)).toBeVisible()
})
