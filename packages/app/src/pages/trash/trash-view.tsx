import type { Session } from "@opencode-ai/schema/session"
import { For, Show, createMemo } from "solid-js"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { sessionTitle } from "@/utils/session-title"
import type { TrashController } from "./trash-controller"

/** Trash view with restore-from-trash and delete-permanently -- the grace-period countdown
 * itself lives on `session.lifecycle` (`{state: "trash", at, purgeAfter}`) and is shown per
 * row; the server enforces the actual grace period, this just displays it. */
export function TrashView(props: { controller: TrashController }) {
  const language = () => props.controller.copy.language

  return (
    <div
      class={`
        m-2 min-h-0 flex-1 self-stretch overflow-hidden rounded-[10px]
        bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]
      `}
    >
      <ScrollView class="h-full">
        <div class="mx-auto flex w-full max-w-[720px] flex-col gap-2 px-3 py-6 lg:px-6">
          <h1 class="text-lg font-medium text-v2-text-text-primary">{language().t("trash.title")}</h1>
          <Show
            when={props.controller.records().length > 0}
            fallback={<p class="text-v2-text-text-muted">{language().t("trash.empty")}</p>}
          >
            <ul class="flex flex-col">
              <For each={props.controller.records()}>
                {(session) => <TrashRow session={session} controller={props.controller} />}
              </For>
            </ul>
          </Show>
        </div>
      </ScrollView>
    </div>
  )
}

function TrashRow(props: { session: Session.Info; controller: TrashController }) {
  const language = () => props.controller.copy.language
  const title = createMemo(() => sessionTitle(props.session.title) || props.session.id)

  return (
    <li class="group/session relative flex items-center gap-2 rounded-md px-2 py-2 hover:bg-v2-background-bg-hover">
      <span class="min-w-0 flex-1 truncate text-v2-text-text-primary">{title()}</span>
      <TooltipV2 class="flex shrink-0 items-center" placement="bottom" value={language().t("common.restore")}>
        <IconButtonV2
          data-action="trash-restore"
          variant="ghost-muted"
          size="large"
          icon={<IconV2 name="arrow-undo-down" />}
          aria-label={language().t("common.restore")}
          onClick={() => void props.controller.restore(props.session)}
        />
      </TooltipV2>
      <TooltipV2 class="flex shrink-0 items-center" placement="bottom" value={language().t("trash.deletePermanently")}>
        <IconButtonV2
          data-action="trash-purge"
          variant="ghost-muted"
          size="large"
          icon={<IconV2 name="trash" />}
          aria-label={language().t("trash.deletePermanently")}
          onClick={() => props.controller.purge(props.session)}
        />
      </TooltipV2>
    </li>
  )
}
