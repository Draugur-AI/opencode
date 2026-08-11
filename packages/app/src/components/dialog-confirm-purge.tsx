import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"

/**
 * The one confirmation dialog this app did not have yet: permanent delete. Per the design
 * post's action table, "Delete permanently" is the only irreversible action and "requires
 * explicit confirmation" that "names exactly what will be removed" -- this is why
 * `trash.deleteConfirm.description` is interpolated with the session's own title rather than a
 * generic "this session" (see `trash-controller.tsx`), and why that key stays uncompressed in
 * translation (Ethan's i18n ruling: the one place translation quality is a safety property).
 */
export function DialogConfirmPurge(props: { readonly title: string; readonly onConfirm: () => void }) {
  const dialog = useDialog()
  const language = useLanguage()

  return (
    <div class="flex w-[360px] flex-col gap-4 rounded-[10px] bg-v2-background-bg-base p-4 shadow-[var(--v2-elevation-raised)]">
      <div class="flex flex-col gap-1">
        <h2 class="text-base font-medium text-v2-text-text-primary">{language.t("trash.deleteConfirm.title")}</h2>
        <p class="text-sm text-v2-text-text-muted">
          {language.t("trash.deleteConfirm.description", { title: props.title })}
        </p>
      </div>
      <div class="flex justify-end gap-2">
        <ButtonV2 variant="outline" size="normal" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2
          variant="danger"
          size="normal"
          onClick={() => {
            props.onConfirm()
            dialog.close()
          }}
        >
          {language.t("trash.deletePermanently")}
        </ButtonV2>
      </div>
    </div>
  )
}
