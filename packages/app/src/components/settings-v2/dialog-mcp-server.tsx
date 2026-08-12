import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { type Accessor, type Component, For, Show, onMount } from "solid-js"
import { useLanguage } from "@/context/language"
import { createMcpServerFormController, type McpServerFormMode } from "./mcp-server-form"
import "./settings-v2.css"

const typeOptions: ("local" | "remote")[] = ["local", "remote"]

export const DialogMcpServer: Component<{
  mode: McpServerFormMode
  serverName?: string
  target: Accessor<string | undefined>
  directory: Accessor<string | undefined>
  onSaved: () => void
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const form = createMcpServerFormController({
    mode: props.mode,
    serverName: props.serverName,
    target: props.target,
    directory: props.directory,
    onSaved: () => {
      props.onSaved()
      dialog.close()
    },
  })

  onMount(() => {
    void form.load()
  })

  const title = () =>
    props.mode === "add" ? language.t("settings.mcp.dialog.add.title") : language.t("settings.mcp.dialog.edit.title")

  return (
    <Dialog fit class="settings-v2-server-dialog">
      <DialogHeader hideClose={true}>
        <DialogTitle>{title()}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full min-w-0 flex-1 flex-col px-4 pt-4 pb-2">
        <div class="flex w-full min-w-0 flex-col gap-6">
          <div class="flex w-full min-w-0 flex-col gap-2">
            <label class="settings-v2-server-dialog-label">{language.t("settings.mcp.dialog.name")}</label>
            <TextInputV2
              type="text"
              appearance="large"
              class="!w-full self-stretch"
              value={form.name()}
              disabled={form.busy() || form.nameLocked()}
              autofocus={props.mode === "add"}
              onInput={(event) => form.setName(event.currentTarget.value)}
            />
          </div>

          <div class="flex w-full min-w-0 flex-col gap-2">
            <label class="settings-v2-server-dialog-label">{language.t("settings.mcp.dialog.type")}</label>
            <SelectV2
              appearance="inline"
              options={typeOptions}
              current={form.type()}
              disabled={form.busy() || form.mode === "edit"}
              placement="bottom-start"
              gutter={6}
              label={(option) =>
                option === "local" ? language.t("settings.mcp.dialog.type.local") : language.t("settings.mcp.dialog.type.remote")
              }
              onSelect={(option) => option && form.setType(option)}
            />
          </div>

          <Show
            when={form.type() === "local"}
            fallback={
              <div class="flex w-full min-w-0 flex-col gap-2">
                <label class="settings-v2-server-dialog-label">{language.t("settings.mcp.dialog.url")}</label>
                <TextInputV2
                  type="text"
                  appearance="large"
                  class="!w-full self-stretch"
                  value={form.url()}
                  disabled={form.busy()}
                  placeholder="https://example.com/mcp"
                  onInput={(event) => form.setUrl(event.currentTarget.value)}
                />
              </div>
            }
          >
            <div class="flex w-full min-w-0 flex-col gap-2">
              <label class="settings-v2-server-dialog-label">{language.t("settings.mcp.dialog.command")}</label>
              <TextInputV2
                type="text"
                appearance="large"
                class="!w-full self-stretch"
                value={form.command()}
                disabled={form.busy()}
                placeholder="npx some-mcp-server"
                onInput={(event) => form.setCommand(event.currentTarget.value)}
              />
            </div>
            <div class="flex w-full min-w-0 flex-col gap-2">
              <label class="settings-v2-server-dialog-label">{language.t("settings.mcp.dialog.cwd")}</label>
              <TextInputV2
                type="text"
                appearance="large"
                class="!w-full self-stretch"
                value={form.cwd()}
                disabled={form.busy()}
                onInput={(event) => form.setCwd(event.currentTarget.value)}
              />
            </div>
          </Show>

          <div class="settings-v2-mcp-form-row">
            <label class="settings-v2-server-dialog-label">{language.t("settings.mcp.dialog.disabled")}</label>
            <Switch checked={form.disabled()} disabled={form.busy()} onChange={form.setDisabled} />
          </div>

          <div class="flex w-full min-w-0 flex-col gap-2">
            <div class="settings-v2-mcp-form-row">
              <label class="settings-v2-server-dialog-label">
                {form.type() === "local"
                  ? language.t("settings.mcp.dialog.environment")
                  : language.t("settings.mcp.dialog.headers")}
              </label>
              <ButtonV2 size="small" variant="ghost-muted" icon="plus" disabled={form.busy()} onClick={form.addCredential}>
                {language.t("common.add")}
              </ButtonV2>
            </div>
            <For each={form.credentials()}>
              {(row, index) => (
                <div class="settings-v2-mcp-credential-row" classList={{ "settings-v2-mcp-credential-row--marked": row.remove }}>
                  <TextInputV2
                    type="text"
                    appearance="base"
                    class="!w-full"
                    value={row.key}
                    disabled={form.busy() || row.existing}
                    placeholder={language.t("settings.mcp.dialog.credentialKey")}
                    onInput={(event) => form.setCredentialKey(index(), event.currentTarget.value)}
                  />
                  <TextInputV2
                    type="password"
                    appearance="base"
                    class="!w-full"
                    value={row.value}
                    disabled={form.busy() || row.remove}
                    placeholder={
                      row.existing
                        ? language.t("settings.mcp.dialog.credentialUnchanged")
                        : language.t("settings.mcp.dialog.credentialValue")
                    }
                    onInput={(event) => form.setCredentialValue(index(), event.currentTarget.value)}
                  />
                  <Show
                    when={row.existing}
                    fallback={
                      <IconButtonV2
                        type="button"
                        variant="ghost-muted"
                        size="small"
                        icon={<Icon name="close" />}
                        disabled={form.busy()}
                        onClick={() => form.removeCredentialRow(index())}
                      />
                    }
                  >
                    <ButtonV2
                      size="small"
                      variant={row.remove ? "neutral" : "ghost-muted"}
                      disabled={form.busy()}
                      onClick={() => form.toggleCredentialRemove(index())}
                    >
                      {row.remove ? language.t("common.undo") : language.t("common.remove")}
                    </ButtonV2>
                  </Show>
                </div>
              )}
            </For>
          </div>

          <Show when={form.error()}>
            <span class="settings-v2-server-dialog-error">{form.error()}</span>
          </Show>
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" disabled={form.busy()} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 variant="contrast" disabled={form.busy()} onClick={() => void form.submit()}>
          {form.busy() ? language.t("common.saving") : language.t("common.save")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
