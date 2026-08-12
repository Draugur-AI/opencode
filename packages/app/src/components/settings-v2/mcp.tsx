import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { type Accessor, type Component, createMemo, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useMcpCatalog, type McpCatalogEntry, type McpLiveStatus } from "@/hooks/use-mcp-catalog"
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

export const SettingsMcpV2: Component<{ directory: Accessor<string | undefined> }> = (props) => {
  const language = useLanguage()
  const { catalog, status } = useMcpCatalog(props.directory)

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

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.mcp.title")}</h2>
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
                            <span class="settings-v2-mcp-status-label">{statusLabel(entry)}</span>
                          </Show>
                          <Show when={errorText(entry)}>
                            {(text) => <span class="settings-v2-mcp-error truncate">{text()}</span>}
                          </Show>
                        </div>
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
