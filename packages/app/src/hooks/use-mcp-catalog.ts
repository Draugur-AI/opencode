import { type Accessor, createEffect, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useServerSDK } from "@/context/server-sdk"
import { createMcpCatalogClient, isServiceUnavailableError } from "@/utils/mcp-catalog-client"
import type { McpListResult, McpStatusResult } from "@/utils/mcp-catalog-client"

export type McpCatalogEntry = McpListResult["data"][number]
export type McpLiveStatus = McpStatusResult["data"][string]

/**
 * `status` is a three-state discriminated union, not a boolean loading flag: a caller must be
 * able to tell "the runtime doesn't exist here" (`unavailable`) apart from "still loading" and
 * from "loaded, here's what it says" -- collapsing `unavailable` into an empty/loading state would
 * render a silent, misleadingly-green catalog for an assembly with no live McpRuntime at all (the
 * exact failure this port exists to make impossible, TKT-323 chunk 2).
 */
export type McpStatusState =
  | { tag: "loading" }
  | { tag: "unavailable" }
  | { tag: "ready"; status: Record<string, McpLiveStatus> }

const statusPollMs = 10_000

export function useMcpCatalog(directory: Accessor<string | undefined>) {
  const sdk = useServerSDK()

  const [catalog, setCatalog] = createStore<{ entries: McpCatalogEntry[]; loading: boolean; error?: string }>({
    entries: [],
    loading: true,
  })
  const [status, setStatus] = createStore<{ state: McpStatusState }>({ state: { tag: "loading" } })

  createEffect(() => {
    const dir = directory()
    // Created once per effect run (directory/server change), not once per call -- list and every
    // status poll share the same server connection instead of each allocating its own client
    // (Copilot review, PR #36).
    const client = createMcpCatalogClient(sdk().server)
    let dead = false
    setCatalog("loading", true)
    setStatus("state", { tag: "loading" })

    void client.mcp
      .list(dir ? { location: { directory: dir } } : undefined)
      .then((result) => {
        if (dead) return
        setCatalog({ entries: [...result.data], loading: false, error: undefined })
      })
      .catch((cause: unknown) => {
        if (dead) return
        setCatalog({ entries: [], loading: false, error: cause instanceof Error ? cause.message : String(cause) })
      })

    const refreshStatus = async () => {
      try {
        const result = await client.mcp.status(dir ? { location: { directory: dir } } : undefined)
        if (dead) return
        setStatus("state", reconcile({ tag: "ready", status: result.data }))
      } catch (cause) {
        if (dead) return
        if (isServiceUnavailableError(cause)) {
          setStatus("state", { tag: "unavailable" })
          return
        }
        // A transient network/auth failure -- not "no runtime," so keep whatever state we last
        // had rather than flipping to `unavailable`, which would misreport WHY status is missing.
      }
    }

    void refreshStatus()
    const id = setInterval(() => void refreshStatus(), statusPollMs)
    onCleanup(() => {
      dead = true
      clearInterval(id)
    })
  })

  return { catalog, status: () => status.state }
}
