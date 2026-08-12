import { createMemo } from "solid-js"
import type { Session } from "@opencode-ai/schema/session"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import * as SessionEntities from "@/context/session-entities"
import { useSessionEntities } from "@/context/session-entities-provider"
import { useTabs } from "@/context/tabs"
import { createSessionLifecycleClient, lifecycleRequestID } from "@/utils/session-lifecycle-client"
import { showToast } from "@/utils/toast"
import { errorMessage } from "@/pages/layout/helpers"

/**
 * Archived sessions for the active server, read directly from the entity store -- the same
 * store home/tabs/etc. read, so this view can never disagree with them about what is archived.
 * No project grouping, no markdown prefetch, no command-palette registration: this is a much
 * smaller surface than home's session list, and borrowing that heavier apparatus for it would
 * be scope creep, not reuse.
 */
export function createArchivedController() {
  const server = useServer()
  const entities = useSessionEntities()
  const tabs = useTabs()
  const language = useLanguage()

  const records = createMemo(() => {
    return SessionEntities.entitiesForServer(entities.state, server.key)
      .filter(([, entity]) => entity.value?.lifecycle.state === "archived")
      .map(([, entity]) => entity.value as Session.Info)
      // `time.updated` is typed as the decoded `DateTimeUtcFromMillis` schema shape, but these
      // objects never actually go through the schema decoder (they arrive as raw client-next
      // JSON, see session-entities-sync.tsx's `as unknown as Session.Info` cast) -- at runtime
      // it is still a plain millis number, same as `compareSessionTime`'s V1-shaped equivalent.
      .sort((a, b) => Number(b.time.updated) - Number(a.time.updated))
  })

  const restore = async (session: Session.Info) => {
    const conn = server.current
    if (!conn) return
    const client = createSessionLifecycleClient(conn)
    try {
      await client.restore({
        sessionID: session.id,
        requestID: lifecycleRequestID(),
        expectedLifecycleRevision: session.lifecycleRevision,
      })
      // No optimistic status here (unlike archive/trash) -- the design deliberately does not
      // list a `restore_pending` state, and the real `session.updated`/`lifecycle.changed`
      // event that follows re-fetches and dispatches for real within a turn or two. The row
      // leaving this list happens because the entity store says so, same discipline as archive.
    } catch (cause) {
      showToast({
        title: language.t("common.requestFailed"),
        description: errorMessage(cause, language.t("common.requestFailed")),
      })
    }
  }

  return {
    copy: { language },
    records,
    restore,
    isOpenTab: (session: Session.Info) =>
      tabs.store.some((tab) => tab.type === "session" && tab.server === server.key && tab.sessionId === session.id),
  }
}

export type ArchivedController = ReturnType<typeof createArchivedController>
