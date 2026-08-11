import { createEffect, onCleanup } from "solid-js"
import type { Session } from "@opencode-ai/schema/session"
import { createSessionLifecycleClient } from "@/utils/session-lifecycle-client"
import { ServerConnection } from "./server"
import { useServerSDK } from "./server-sdk"
import { useSessionEntities } from "./session-entities-provider"
import { useTabs } from "./tabs"

/**
 * Feeds the normalized session-entities store from the real server: a full lifecycle-aware
 * snapshot on bootstrap and on every reconnect, and live session/purge updates in between. This
 * is the piece PR #13 (TKT-314's state half) deliberately left undone -- the reducer and
 * `TabsProvider.reconcile()` existed, but nothing dispatched to them: `useSessionEntities()` had
 * exactly one caller in the whole app (an optimistic archive dispatch) and `SessionEntitiesProvider`
 * was never even mounted. This component, plus mounting the provider in app.tsx, is that feed.
 *
 * Deliberately separate from `server-sync.tsx`'s own central event listener rather than editing
 * it in place: that listener runs inside `GlobalProvider`, above `TabsProvider` in the tree, and
 * calling `useSessionEntities()`/`useTabs()` from there would mean restructuring the provider
 * order for unclear gain. `useServerSDK().event.listen(...)` is the same underlying emitter
 * `server-sync.tsx` subscribes to (both resolve through `GlobalProvider`'s per-server
 * `ensureServerCtx`), so a second, independent listener here sees the identical event stream
 * without touching that file at all.
 *
 * Two spec anchors (design post, "startup" section), both load-bearing:
 * - Snapshots load BEFORE tabs restore: `runSnapshot` waits for `tabs.ready()` before calling
 *   `reconcile`, so a snapshot that resolves first does not reconcile against tabs that have not
 *   loaded their persisted references yet -- it would silently find nothing to do.
 * - Navigation happens ONCE after the batch: each snapshot calls `reconcile` exactly once for
 *   its whole set, never once per session inside it -- that per-tab bounce (closing several
 *   sessions used to route through each intermediate tab) is the bug this replaces. A live
 *   `session`/`purged` dispatch (one event, one session) also calls `reconcile` once right
 *   after -- that IS one batch of one, the same shape, and it is what makes archiving a session
 *   from anywhere still close its own tab immediately once the five old dispatch sites
 *   (titlebar-session-events.ts and friends) are deleted, rather than only on the next
 *   reconnect. Not a live-vs-snapshot distinction; a one-navigation-per-event invariant that
 *   both paths satisfy.
 */

const SNAPSHOT_PAGE_LIMIT = 5_000

async function fetchAllSessions(
  client: ReturnType<typeof createSessionLifecycleClient>,
): Promise<readonly Session.Info[]> {
  const sessions: Session.Info[] = []
  let cursor: string | undefined
  for (;;) {
    const page = await client.list({
      lifecycle: "all",
      limit: SNAPSHOT_PAGE_LIMIT,
      order: "desc",
      ...(cursor ? { cursor } : {}),
    })
    sessions.push(...(page.data as unknown as Session.Info[]))
    if (page.data.length < SNAPSHOT_PAGE_LIMIT || !page.cursor.next) return sessions
    cursor = page.cursor.next
  }
}

export function SessionEntitiesSync() {
  const sdk = useServerSDK()
  const entities = useSessionEntities()
  const tabs = useTabs()

  // Per-connection, not per-component: a server switch tears down and re-runs the effect below,
  // and the fresh connection's first `server.connected` must be treated as the initial bootstrap
  // for THAT connection, not a reconnect carried over from the previous one.
  let everConnected = false

  const runSnapshot = async () => {
    const conn = sdk().server
    if (conn.type !== "http") return
    const client = createSessionLifecycleClient(conn.http)
    const serverKey = ServerConnection.key(conn)
    const sessions = await fetchAllSessions(client)
    entities.dispatch({ type: "snapshot", serverKey, sessions })
    if (!tabs.ready()) await tabs.ready.promise
    tabs.reconcile(entities.state)
  }

  createEffect(() => {
    const conn = sdk().server
    everConnected = false
    if (conn.type !== "http") return

    void runSnapshot()

    // Widened deliberately, matching global-sync/event-reducer.ts's own event parameter type:
    // the precise event union this SDK generation exposes predates `session.next.lifecycle.
    // changed` at the type level even though the real server emits it (the same multi-client-
    // generation staleness FORK.md's ledger already documents elsewhere), so `event.type` cannot
    // be switched over as a literal without a cast.
    const unlisten = sdk().event.listen((e) => {
      const conn = sdk().server
      if (conn.type !== "http") return
      const serverKey = ServerConnection.key(conn)
      const event = e.details as { type: string; properties?: unknown }

      const refetchAndDispatch = (sessionID: string) => {
        const client = createSessionLifecycleClient(conn.http)
        // SessionsGetOutput is already the flat session shape (its own generated type alias is
        // self-indexed to `["data"]`) -- no wrapper to unwrap here, unlike SessionsListOutput.
        // A 404 here is a real, if rare, race (the session was purged between the event firing
        // and this re-fetch landing) -- the purge itself arrives as its own `session.deleted`
        // event, so there is nothing to dispatch and nothing lost by swallowing it here.
        void client
          .get({ sessionID })
          .then((session) => {
            entities.dispatch({ type: "session", serverKey, session: session as unknown as Session.Info })
            tabs.reconcile(entities.state)
          })
          .catch(() => {})
      }

      switch (event.type) {
        // None of these three carry a V2-shaped session with `lifecycle`/`lifecycleRevision` --
        // `session.created`/`session.updated`'s `info` is the OLDER V1 `Session` type (no
        // lifecycle fields at all), and `session.next.lifecycle.changed` carries only
        // `from`/`to`/`requestID` (checked the schema directly, no revision either). The V1
        // `session.updated` mirror also does not cover trash transitions (V1 has no trash
        // concept), so treating all three the same way -- re-fetch, dispatch as a fresh
        // snapshot entry -- is simpler and more correct than trying to special-case which ones
        // happen to carry enough to construct a `lifecycle` message directly.
        case "session.created":
        case "session.updated": {
          const info = (event.properties as { info?: { id?: string } } | undefined)?.info
          if (info?.id) refetchAndDispatch(info.id)
          return
        }
        case "session.next.lifecycle.changed": {
          const sessionID = (event.properties as { sessionID?: string } | undefined)?.sessionID
          if (sessionID) refetchAndDispatch(sessionID)
          return
        }
        case "session.deleted": {
          const properties = event.properties as { sessionID?: string; info?: { id?: string } } | undefined
          const sessionID = properties?.info?.id ?? properties?.sessionID
          if (!sessionID) return
          entities.dispatch({ type: "purged", serverKey, sessionID })
          tabs.reconcile(entities.state)
          return
        }
        case "server.connected": {
          if (everConnected) void runSnapshot()
          everConnected = true
          return
        }
      }
    })

    onCleanup(unlisten)
  })

  return null
}
