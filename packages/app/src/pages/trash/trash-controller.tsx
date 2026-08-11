import { createMemo } from "solid-js"
import type { Session } from "@opencode-ai/schema/session"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogConfirmPurge } from "@/components/dialog-confirm-purge"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import * as SessionEntities from "@/context/session-entities"
import { useSessionEntities } from "@/context/session-entities-provider"
import { useTabs } from "@/context/tabs"
import { createSessionLifecycleClient, lifecycleRequestID } from "@/utils/session-lifecycle-client"
import { showToast } from "@/utils/toast"
import { errorMessage } from "@/pages/layout/helpers"
import { sessionTitle } from "@/utils/session-title"

/** Trash view: restore-from-trash (reversible, no confirmation) and delete permanently
 * (irreversible, confirmed -- see DialogConfirmPurge). Same lightweight, entity-store-direct
 * pattern as the Archived view; the two are siblings, not a shared abstraction, since the
 * moment they'd need to diverge (this one has two actions and a confirmation) is now. */
export function createTrashController() {
  const server = useServer()
  const entities = useSessionEntities()
  const tabs = useTabs()
  const language = useLanguage()
  const dialog = useDialog()

  const records = createMemo(() => {
    return SessionEntities.entitiesForServer(entities.state, server.key)
      .filter(([, entity]) => entity.value?.lifecycle.state === "trash")
      .map(([, entity]) => entity.value as Session.Info)
      .sort((a, b) => Number(b.time.updated) - Number(a.time.updated))
  })

  const restore = async (session: Session.Info) => {
    const conn = server.current
    if (!conn || conn.type !== "http") return
    const client = createSessionLifecycleClient(conn.http)
    try {
      await client.restoreFromTrash({
        sessionID: session.id,
        requestID: lifecycleRequestID(),
        expectedLifecycleRevision: session.lifecycleRevision,
      })
    } catch (cause) {
      showToast({
        title: language.t("common.requestFailed"),
        description: errorMessage(cause, language.t("common.requestFailed")),
      })
    }
  }

  const purge = (session: Session.Info) => {
    dialog.show(() => (
      <DialogConfirmPurge
        title={sessionTitle(session.title) || session.id}
        onConfirm={() => {
          void (async () => {
            const conn = server.current
            if (!conn || conn.type !== "http") return
            const client = createSessionLifecycleClient(conn.http)
            try {
              await client.purge({ sessionID: session.id, requestID: lifecycleRequestID() })
            } catch (cause) {
              showToast({
                title: language.t("common.requestFailed"),
                description: errorMessage(cause, language.t("common.requestFailed")),
              })
            }
          })()
        }}
      />
    ))
  }

  return {
    copy: { language },
    records,
    restore,
    purge,
    isOpenTab: (session: Session.Info) =>
      tabs.store.some((tab) => tab.type === "session" && tab.server === server.key && tab.sessionId === session.id),
  }
}

export type TrashController = ReturnType<typeof createTrashController>
