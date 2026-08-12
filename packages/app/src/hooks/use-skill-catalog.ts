import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useServerSDK } from "@/context/server-sdk"
import { createSkillClient } from "@/utils/skill-client"
import type { SkillCatalogResult } from "@/utils/skill-client"

export type SkillCatalogEntry = SkillCatalogResult["data"][number]

/**
 * No live-status polling, unlike `useMcpCatalog` -- a skill has no connection to be up or down;
 * the catalog IS the whole fact (winner or shadowed loser, with provenance), computed fresh from
 * config + filesystem on every fetch. One request per directory change is the whole story.
 */
export function useSkillCatalog(directory: Accessor<string | undefined>) {
  const sdk = useServerSDK()

  const [catalog, setCatalog] = createStore<{ entries: SkillCatalogEntry[]; loading: boolean; error?: string }>({
    entries: [],
    loading: true,
  })
  const [refreshToken, setRefreshToken] = createSignal(0)

  createEffect(() => {
    const dir = directory()
    refreshToken()
    const client = createSkillClient(sdk().server)
    let dead = false
    setCatalog("loading", true)

    void client
      .catalog(dir ? { location: { directory: dir } } : undefined)
      .then((result) => {
        if (dead) return
        setCatalog({ entries: [...result.data], loading: false, error: undefined })
      })
      .catch((cause: unknown) => {
        if (dead) return
        setCatalog({ entries: [], loading: false, error: cause instanceof Error ? cause.message : String(cause) })
      })

    onCleanup(() => {
      dead = true
    })
  })

  return { catalog, refetch: () => setRefreshToken((n) => n + 1) }
}
