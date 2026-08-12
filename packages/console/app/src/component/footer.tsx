import { createAsync } from "@solidjs/router"
import { createMemo, Show } from "solid-js"
import { github } from "~/lib/github"
import { config } from "~/config"
import { useLanguage } from "~/context/language"
import { useI18n } from "~/context/i18n"

export function Footer() {
  const language = useLanguage()
  const i18n = useI18n()
  const githubData = createAsync(() => github())
  // No static fallback (TKT-396 item 6, Ethan's ruling): the prior fallback was upstream's own
  // star count, not this fork's -- same misrepresentation as the removed changelog/growth-stats.
  // Hide the badge rather than show a number when the live fetch has nothing (undefined) to show.
  const starCount = createMemo(() =>
    githubData()?.stars
      ? new Intl.NumberFormat(language.tag(language.locale()), {
          notation: "compact",
          compactDisplay: "short",
        }).format(githubData()!.stars!)
      : undefined,
  )

  return (
    <footer data-component="footer">
      <div data-slot="cell">
        <a href={config.github.repoUrl} target="_blank">
          {i18n.t("footer.github")} <Show when={starCount()}>{(count) => <span>[{count()}]</span>}</Show>
        </a>
      </div>
      <div data-slot="cell">
        <a href={language.route("/docs")}>{i18n.t("footer.docs")}</a>
      </div>
    </footer>
  )
}
