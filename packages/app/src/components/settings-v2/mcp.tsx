import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { type Accessor, type Component, createMemo, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { createMcpClient, isServiceUnavailableError } from "@/utils/mcp-client"
import type { McpConfigTargetListResult } from "@/utils/mcp-client"
import { showToast } from "@/utils/toast"
import { useMcpCatalog, type McpCatalogEntry, type McpLiveStatus } from "@/hooks/use-mcp-catalog"
import { DialogMcpServer } from "./dialog-mcp-server"
import { SettingsListV2 } from "./parts/list"
import "./settings-v2.css"

const LIVE_STATUS_LABEL_KEY: Record<McpLiveStatus["status"], string> = {
  connected: "mcp.status.connected",
  failed: "mcp.status.failed",
  disabled: "mcp.status.disabled",
  needs_auth: "mcp.status.needs_auth",
  needs_client_registration: "mcp.status.needs_client_registration",
}

/**
 * Same dot-color convention as the legacy MCP status popover
 * (status-popover-body.tsx) -- connected=success, failed=critical, disabled=muted,
 * needs_auth/needs_client_registration=warning -- plus an `unavailable` case that popover never
 * had to model (it assumes a runtime always exists). `unavailable` gets its own muted treatment,
 * distinct from `disabled`: those are different facts (no live runtime vs. a user's own toggle)
 * and must render differently, or an operator reading "gray dot" cannot tell them apart.
 */
const McpStatusIndicator: Component<{ status: McpLiveStatus["status"] | "unavailable" | "loading" }> = (props) => {
  return (
    <div
      classList={{
        "size-1.5 rounded-full shrink-0 my-[3.5px]": true,
        "bg-icon-success-base": props.status === "connected",
        "bg-icon-critical-base": props.status === "failed",
        "bg-border-weak-base": props.status === "disabled" || props.status === "loading",
        "bg-icon-warning-base": props.status === "needs_auth" || props.status === "needs_client_registration",
        "bg-v2-icon-icon-muted": props.status === "unavailable",
      }}
    />
  )
}

const DialogConfirmRemoveMcpServer: Component<{
  name: string
  target: Accessor<string | undefined>
  directory: Accessor<string | undefined>
  onRemoved: () => void
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useServerSDK()
  const [busy, setBusy] = createSignal(false)

  const confirm = async () => {
    const targetID = props.target()
    if (!targetID) return
    setBusy(true)
    try {
      const client = createMcpClient(sdk().server)
      const locationInput = props.directory() ? { location: { directory: props.directory()! } } : undefined
      const read = await client.configDocument.targetRead({ targetID, ...locationInput })
      await client.configDocument.targetApply({
        targetID,
        expectedHash: read.data.hash,
        ...locationInput,
        patch: { op: "mcp.server.remove", name: props.name },
      })
      props.onRemoved()
      dialog.close()
    } catch (cause) {
      const message = isServiceUnavailableError(cause)
        ? "No live server to write through."
        : cause instanceof Error
          ? cause.message
          : String(cause)
      showToast({ title: language.t("common.requestFailed"), description: message })
      setBusy(false)
    }
  }

  return (
    <div class="flex w-[360px] flex-col gap-4 rounded-[10px] bg-v2-background-bg-base p-4 shadow-[var(--v2-elevation-raised)]">
      <div class="flex flex-col gap-1">
        <h2 class="text-base font-medium text-v2-text-text-primary">
          {language.t("settings.mcp.dialog.remove.title", { name: props.name })}
        </h2>
        <p class="text-sm text-v2-text-text-muted">{language.t("settings.mcp.dialog.remove.description")}</p>
      </div>
      <div class="flex justify-end gap-2">
        <ButtonV2 variant="outline" size="normal" disabled={busy()} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 variant="danger" size="normal" disabled={busy()} onClick={() => void confirm()}>
          {language.t("common.remove")}
        </ButtonV2>
      </div>
    </div>
  )
}

export const SettingsMcpV2: Component<{ directory: Accessor<string | undefined> }> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const sdk = useServerSDK()
  const { catalog, status, refetch } = useMcpCatalog(props.directory)

  const sorted = createMemo(() => [...catalog.entries].sort((a, b) => a.name.localeCompare(b.name)))

  const liveStatus = (entry: McpCatalogEntry): McpLiveStatus["status"] | "unavailable" | "loading" => {
    const state = status()
    if (state.tag === "unavailable") return "unavailable"
    if (state.tag === "loading") return "loading"
    const live = state.status[entry.name]
    // Missing from the live map is a timing gap (status hasn't caught up with a just-changed
    // catalog yet), not a fourth meaning -- render it the same as still-loading rather than
    // inventing a status the server never reported.
    return live?.status ?? "loading"
  }

  const errorText = (entry: McpCatalogEntry): string | undefined => {
    const state = status()
    if (state.tag !== "ready") return
    const live = state.status[entry.name]
    if (live?.status === "failed" || live?.status === "needs_client_registration") return live.error
  }

  const statusLabel = (entry: McpCatalogEntry) => {
    const value = liveStatus(entry)
    if (value === "unavailable") return language.t("settings.mcp.status.unavailable")
    if (value === "loading") return undefined
    return language.t(LIVE_STATUS_LABEL_KEY[value])
  }

  // A brand-new server has no existing catalog entry to read a target off of -- resolve the
  // project target explicitly via targetList (falling back to whatever comes back first, e.g.
  // global, only if no project target exists at all, which listTargets never actually omits: it
  // always synthesizes a creatable project candidate even when no file exists yet).
  const resolveAddTarget = async (): Promise<string | undefined> => {
    try {
      const result: McpConfigTargetListResult = await createMcpClient(sdk().server).configDocument.targetList(
        props.directory() ? { location: { directory: props.directory()! } } : undefined,
      )
      const project = result.data.find((target) => target.kind === "project")
      return (project ?? result.data[0])?.id
    } catch {
      return undefined
    }
  }

  const openAdd = async () => {
    const targetID = await resolveAddTarget()
    if (!targetID) {
      showToast({ title: language.t("common.requestFailed") })
      return
    }
    dialog.push(() => (
      <DialogMcpServer mode="add" target={() => targetID} directory={props.directory} onSaved={refetch} />
    ))
  }

  const openEdit = (entry: McpCatalogEntry) => {
    dialog.push(() => (
      <DialogMcpServer
        mode="edit"
        serverName={entry.name}
        target={() => entry.target}
        directory={props.directory}
        onSaved={refetch}
      />
    ))
  }

  const openRemove = (entry: McpCatalogEntry) => {
    dialog.show(() => (
      <DialogConfirmRemoveMcpServer
        name={entry.name}
        target={() => entry.target}
        directory={props.directory}
        onRemoved={refetch}
      />
    ))
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <div class="settings-v2-tab-header-row">
          <h2 class="settings-v2-tab-title">{language.t("settings.mcp.title")}</h2>
          <ButtonV2 size="normal" variant="neutral" icon="plus" onClick={() => void openAdd()}>
            {language.t("settings.mcp.action.add")}
          </ButtonV2>
        </div>
      </div>

      <div class="settings-v2-tab-body settings-v2-mcp">
        <Show when={status().tag === "unavailable"}>
          <div class="settings-v2-mcp-banner" data-component="mcp-runtime-unavailable">
            {language.t("settings.mcp.runtimeUnavailable")}
          </div>
        </Show>

        <SettingsListV2>
          <Show
            when={!catalog.loading}
            fallback={<div class="settings-v2-mcp-empty">{language.t("common.loading")}</div>}
          >
            <Show
              when={!catalog.error}
              fallback={
                <div class="settings-v2-mcp-empty">
                  {language.t("common.requestFailed")}
                  <Show when={catalog.error}>{(text) => <span class="settings-v2-mcp-error"> -- {text()}</span>}</Show>
                </div>
              }
            >
              <Show
                when={sorted().length > 0}
                fallback={<div class="settings-v2-mcp-empty">{language.t("dialog.mcp.empty")}</div>}
              >
                <For each={sorted()}>
                  {(entry) => (
                    <div class="settings-v2-mcp-row">
                      <div class="settings-v2-mcp-lead">
                        <McpStatusIndicator status={liveStatus(entry)} />
                        <div class="settings-v2-mcp-copy">
                          <div class="settings-v2-mcp-main">
                            <span class="settings-v2-mcp-name truncate">{entry.name}</span>
                            <Tag>{entry.transport}</Tag>
                            <Show when={entry.status === "disabled"}>
                              <Tag>{language.t("mcp.status.disabled")}</Tag>
                            </Show>
                          </div>
                          <Show when={statusLabel(entry)}>
                            {(label) => <span class="settings-v2-mcp-status-label">{label()}</span>}
                          </Show>
                          <Show when={errorText(entry)}>
                            {(text) => <span class="settings-v2-mcp-error truncate">{text()}</span>}
                          </Show>
                        </div>
                      </div>
                      <div class="settings-v2-mcp-actions">
                        <IconButtonV2
                          type="button"
                          variant="ghost-muted"
                          size="small"
                          icon={<Icon name="edit" />}
                          aria-label={language.t("settings.mcp.action.edit")}
                          onClick={() => openEdit(entry)}
                        />
                        <IconButtonV2
                          type="button"
                          variant="ghost-muted"
                          size="small"
                          icon={<Icon name="trash" />}
                          aria-label={language.t("settings.mcp.action.remove")}
                          onClick={() => openRemove(entry)}
                        />
                      </div>
                    </div>
                  )}
                </For>
              </Show>
            </Show>
          </Show>
        </SettingsListV2>
      </div>
    </>
  )
}
