import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { type Component, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useLanguage } from "@/context/language"
import { normalizeServerUrl, type ServerConnection, serverName } from "@/context/server"
import { SettingsServerDataScope } from "../settings-server-picker"
import { useServerManagementController } from "../dialog-select-server"
import { createShellOptions, createShellSettingsController } from "./general-controllers"
import "./settings-v2.css"

const ServerShellField: Component = () => {
  const language = useLanguage()
  const controller = createShellSettingsController()
  const options = createMemo(() =>
    createShellOptions({
      shells: controller.shells(),
      current: controller.current(),
    }),
  )

  return (
    <div class="flex w-full min-w-0 flex-col gap-2">
      <label class="settings-v2-server-dialog-label">{language.t("settings.general.row.shell.title")}</label>
      <SelectV2
        appearance="large"
        class="!w-full self-stretch"
        data-action="settings-shell"
        options={options()}
        current={options().find((option) => option.value === controller.current()) ?? options()[0]}
        placement="bottom-end"
        gutter={6}
        value={(option) => option.id}
        label={(option) => {
          if (option.id === "auto") return language.t("settings.general.row.shell.autoDefault")
          if (!option.terminalOnly) return option.name
          return `${option.name} (${language.t("settings.general.row.shell.terminalOnly")})`
        }}
        onSelect={(option) => option && controller.select(option.value)}
      />
      <span class="text-11-regular text-v2-text-text-muted">
        {language.t("settings.general.row.shell.description")}
      </span>
    </div>
  )
}

const ScopedServerShellField: Component<{ server: ServerConnection.Any }> = (props) => (
  <SettingsServerDataScope server={props.server}>
    <ServerShellField />
  </SettingsServerDataScope>
)

export const DialogServerV2: Component<{
  mode: "add" | "edit"
  server?: ServerConnection.Any
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const controller = useServerManagementController({
    onSelect: () => dialog.close(),
    navigateOnAdd: false,
  })
  const [opened, setOpened] = createSignal(false)
  const [step, setStep] = createSignal<"address" | "authenticate">("address")
  const managed = () => props.mode === "edit" && props.server?.type !== "http"

  onMount(() => {
    if (props.mode === "add") controller.startAdd()
    if (props.mode === "edit" && props.server?.type === "http") controller.startEdit(props.server)
    setOpened(true)
  })

  onCleanup(() => {
    controller.resetForm()
  })

  createEffect(() => {
    if (!opened() || managed()) return
    if (controller.isFormMode()) return
    dialog.close()
  })

  const authenticate = () => {
    if (!normalizeServerUrl(controller.formValue())) return
    if (!controller.formName()) controller.handleFormNameChange()(controller.formValue())
    setStep("authenticate")
  }

  const submit = () => {
    if (managed()) {
      dialog.close()
      return
    }
    if (props.mode === "add" && step() === "address") {
      authenticate()
      return
    }
    controller.submitForm()
  }

  const keyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || event.isComposing) return
    event.preventDefault()
    submit()
  }

  const showConnectionFields = () => !managed() && (props.mode === "edit" || step() === "authenticate")
  const shellServer = createMemo<ServerConnection.Any | undefined>(() => {
    if (managed()) return props.server
    if (props.mode === "add") return
    if (!showConnectionFields()) return
    const url = normalizeServerUrl(controller.formValue())
    if (!url) return
    const http: ServerConnection.HttpBase = { url }
    if (controller.formPassword()) http.password = controller.formPassword()
    if (controller.formPassword() && controller.formUsername()) http.username = controller.formUsername()
    return {
      type: "http",
      displayName: controller.formName() || undefined,
      http,
    }
  })

  const title = () => {
    if (props.mode === "edit") return language.t("dialog.server.edit.title")
    if (step() === "address") return language.t("dialog.server.add.title")
    return (
      <span class="flex items-center gap-2">
        <span class="text-v2-text-text-muted">{language.t("dialog.server.add.title")}</span>
        <span aria-hidden="true">›</span>
        <span>{language.t("dialog.server.authenticate.title")}</span>
      </span>
    )
  }

  return (
    <Dialog fit class="settings-v2-server-dialog">
      <DialogHeader hideClose={true}>
        <DialogTitle>{title()}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full min-w-0 flex-1 flex-col px-4 pt-4 pb-2">
        <div class="flex w-full min-w-0 flex-col gap-6">
          <Show
            when={props.mode === "add" && step() === "address"}
            fallback={
              <>
                <Show
                  when={!managed()}
                  fallback={
                    <Show when={props.server?.type === "sidecar" && props.server.variant === "wsl"}>
                      <div class="flex w-full min-w-0 flex-col gap-2">
                        <label class="settings-v2-server-dialog-label">{language.t("dialog.server.add.name")}</label>
                        <TextInputV2
                          type="text"
                          appearance="large"
                          class="!w-full self-stretch"
                          value={serverName(props.server)}
                          disabled
                        />
                      </div>
                    </Show>
                  }
                >
                  <div class="flex w-full min-w-0 flex-col gap-2">
                    <label class="settings-v2-server-dialog-label">{language.t("dialog.server.add.url")}</label>
                    <TextInputV2
                      type="text"
                      appearance="large"
                      class="!w-full self-stretch"
                      value={controller.formValue()}
                      placeholder={language.t("dialog.server.add.placeholder")}
                      invalid={!!controller.formError()}
                      disabled={controller.formBusy()}
                      onInput={(event) => controller.handleFormChange()(event.currentTarget.value)}
                      onKeyDown={keyDown}
                    />
                    <Show when={controller.formError()}>
                      <span class="settings-v2-server-dialog-error">{controller.formError()}</span>
                    </Show>
                  </div>
                  <div class="flex w-full min-w-0 flex-col gap-2">
                    <label class="settings-v2-server-dialog-label">{language.t("dialog.server.add.name")}</label>
                    <TextInputV2
                      type="text"
                      appearance="large"
                      class="!w-full self-stretch"
                      value={controller.formName()}
                      placeholder={language.t("dialog.server.add.namePlaceholder")}
                      disabled={controller.formBusy()}
                      onInput={(event) => controller.handleFormNameChange()(event.currentTarget.value)}
                      onKeyDown={keyDown}
                    />
                  </div>
                  <div class="flex w-full min-w-0 flex-col gap-2">
                    <label class="settings-v2-server-dialog-label">{language.t("dialog.server.add.username")}</label>
                    <TextInputV2
                      type="text"
                      appearance="large"
                      class="!w-full self-stretch"
                      value={controller.formUsername()}
                      placeholder={language.t("dialog.server.add.usernamePlaceholder")}
                      disabled={controller.formBusy()}
                      onInput={(event) => controller.handleFormUsernameChange()(event.currentTarget.value)}
                      onKeyDown={keyDown}
                    />
                  </div>
                  <div class="flex w-full min-w-0 flex-col gap-2">
                    <label class="settings-v2-server-dialog-label">{language.t("dialog.server.add.password")}</label>
                    <TextInputV2
                      type="password"
                      appearance="large"
                      class="!w-full self-stretch"
                      value={controller.formPassword()}
                      placeholder={language.t("dialog.server.add.passwordPlaceholder")}
                      disabled={controller.formBusy()}
                      onInput={(event) => controller.handleFormPasswordChange()(event.currentTarget.value)}
                      onKeyDown={keyDown}
                    />
                  </div>
                </Show>
                <Show when={shellServer()} keyed>
                  {(server) => <ScopedServerShellField server={server} />}
                </Show>
              </>
            }
          >
            <div class="flex w-full min-w-0 flex-col gap-2">
              <label class="settings-v2-server-dialog-label">
                {language.t("dialog.server.add.url")}
                <span class="text-v2-text-text-danger">*</span>
              </label>
              <TextInputV2
                type="text"
                appearance="large"
                class="!w-full self-stretch"
                value={controller.formValue()}
                placeholder={language.t("dialog.server.add.placeholder")}
                disabled={controller.formBusy()}
                autofocus
                onInput={(event) => controller.handleFormChange()(event.currentTarget.value)}
                onKeyDown={keyDown}
              />
            </div>
          </Show>
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" disabled={controller.formBusy()} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2
          variant="contrast"
          disabled={controller.formBusy() || (props.mode === "add" && step() === "address" && !controller.formValue())}
          onClick={submit}
        >
          {controller.formBusy() ? language.t("dialog.server.add.checking") : language.t("dialog.server.add.button")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
