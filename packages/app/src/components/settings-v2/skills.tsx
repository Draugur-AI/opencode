import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { type Accessor, type Component, createMemo, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSkillCatalog, type SkillCatalogEntry } from "@/hooks/use-skill-catalog"
import { SettingsListV2 } from "./parts/list"
import "./settings-v2.css"

const sourceLabel = (entry: SkillCatalogEntry): string => {
  if (entry.source.type === "directory") return entry.source.path
  if (entry.source.type === "url") return entry.source.url
  return entry.source.skill.name
}

export const SettingsSkillsV2: Component<{ directory: Accessor<string | undefined> }> = (props) => {
  const language = useLanguage()
  const { catalog } = useSkillCatalog(props.directory)

  // Winners first, then shadowed losers, each group alphabetical -- a reader scanning top-to-
  // bottom sees what's actually available before what's overridden, rather than an arbitrary
  // registration-order interleaving.
  const sorted = createMemo(() =>
    [...catalog.entries].sort((a, b) => {
      if (!a.shadowedBy !== !b.shadowedBy) return a.shadowedBy ? 1 : -1
      return a.skill.name.localeCompare(b.skill.name)
    }),
  )

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.skills.title")}</h2>
      </div>

      <div class="settings-v2-tab-body settings-v2-skills">
        <SettingsListV2>
          <Show
            when={!catalog.loading}
            fallback={<div class="settings-v2-skills-empty">{language.t("common.loading")}</div>}
          >
            <Show
              when={!catalog.error}
              fallback={
                <div class="settings-v2-skills-empty">
                  {language.t("common.requestFailed")}
                  <Show when={catalog.error}>{(text) => <span class="settings-v2-skills-error"> -- {text()}</span>}</Show>
                </div>
              }
            >
              <Show
                when={sorted().length > 0}
                fallback={<div class="settings-v2-skills-empty">{language.t("settings.skills.empty")}</div>}
              >
                <For each={sorted()}>
                  {(entry) => (
                    <div class="settings-v2-skill-row">
                      <div class="settings-v2-skill-copy">
                        <div class="settings-v2-skill-main">
                          <span class="settings-v2-skill-name truncate">{entry.skill.name}</span>
                          <Show when={entry.skill.slash}>
                            <Tag>{language.t("settings.skills.slash")}</Tag>
                          </Show>
                          <Show when={entry.shadowedBy}>
                            <Tag>{language.t("settings.skills.shadowed")}</Tag>
                          </Show>
                        </div>
                        <Show when={entry.skill.description}>
                          {(text) => <span class="settings-v2-skill-description truncate">{text()}</span>}
                        </Show>
                        <span class="settings-v2-skill-source truncate">{sourceLabel(entry)}</span>
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
