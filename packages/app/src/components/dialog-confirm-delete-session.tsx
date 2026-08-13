import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogFooter, DialogHeader, DialogTitleGroup, DialogV2 } from "@opencode-ai/ui/v2/dialog-v2"
import { useLanguage } from "@/context/language"

/**
 * Same copy as the in-session "Delete..." confirmation (message-timeline.tsx's
 * DialogDeleteSession) -- reusing the session.delete.* i18n keys rather than new ones keeps the
 * wording identical wherever a user is asked to confirm the same trash transition, home list
 * included (TKT-421). Trash is recoverable until its purge deadline; DialogConfirmPurge in this
 * same directory is the separate, permanent-delete confirmation for the Trash view.
 */
export function DialogConfirmDeleteSession(props: { readonly title: string; readonly onConfirm: () => void }) {
  const dialog = useDialog()
  const language = useLanguage()

  return (
    <DialogV2 fit>
      <DialogHeader hideClose>
        <DialogTitleGroup
          title={language.t("session.delete.title")}
          description={language.t("session.delete.confirm", { name: props.title })}
        />
      </DialogHeader>
      <DialogFooter>
        <ButtonV2 variant="ghost" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2
          variant="danger"
          onClick={() => {
            props.onConfirm()
            dialog.close()
          }}
        >
          {language.t("session.delete.button")}
        </ButtonV2>
      </DialogFooter>
    </DialogV2>
  )
}
