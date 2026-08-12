import { describe, expect, test } from "bun:test"
import { desktopNativePluralCategories } from "./desktop-native"

const appLocales = [
  "ar",
  "br",
  "bs",
  "da",
  "de",
  "es",
  "fr",
  "ja",
  "ko",
  "no",
  "pl",
  "ru",
  "uk",
  "th",
  "tr",
  "zh",
  "zht",
  "hi",
  "nl",
  "id",
  "vi",
  "it",
  "ur",
  "pa",
  "az",
  "fi",
  "sv",
  "am",
  "bg",
  "bn",
  "ca",
  "cs",
  "dv",
  "dz",
  "el",
  "et",
  "fa",
  "fo",
  "hr",
  "hu",
  "hy",
  "is",
  "ka",
  "km",
  "lo",
  "lt",
  "lv",
  "mk",
  "mn",
  "ms",
  "my",
  "ne",
  "ro",
  "si",
  "sk",
  "sl",
  "sq",
  "sr",
  "tg",
  "tk",
  "uz",
] as const
const desktopLocales = appLocales
const pluralCategories = new Map(
  appLocales.map(
    (locale) =>
      [
        locale,
        desktopNativePluralCategories(locale).filter((category) => category !== "one" && category !== "other"),
      ] as const,
  ),
)

const domains = [
  {
    name: "app",
    source: "./en.ts",
    target: (locale: string) => `./${locale}.ts`,
    locales: appLocales,
  },
  {
    name: "ui",
    source: "../../../ui/src/i18n/en.ts",
    target: (locale: string) => `../../../ui/src/i18n/${locale}.ts`,
    locales: appLocales,
  },
  {
    name: "desktop",
    source: "../../../desktop/src/renderer/i18n/en.ts",
    target: (locale: string) => `../../../desktop/src/renderer/i18n/${locale}.ts`,
    locales: desktopLocales,
  },
] as const

/**
 * Deliberate, scoped, evidenced exceptions to "every locale has every key" -- structurally, not
 * just by convention: an entry names the exact domain + locale + key it exempts, why, and the
 * feedback item tracking the real fix, so an unscoped or unexplained exception cannot exist here.
 * A key not in this list still fails the check below exactly as before.
 *
 * The app itself does not break on a listed gap -- language.tsx's `merge()` spreads each locale's
 * dict onto the English base, so a missing key falls back to correct English, never to a blank or
 * a crash. That fallback is what makes shipping with an entry here safe; it is not what makes the
 * entry unnecessary to fix.
 *
 * Un-except condition: delete the entry the moment its locale has a verified translation for that
 * key. Never widen an entry's scope (a new locale, a new key) to work around a fresh failure --
 * file new feedback and add a new entry with its own evidence instead.
 */
const KNOWN_MISSING: readonly { domain: "app" | "ui" | "desktop"; locale: string; key: string; reason: string; feedback: string }[] = [
  // TKT-314: litellm/qwen3-6 failed Dhivehi (dv) twice on these 8 keys, in two different ways --
  // attempt 1 produced a degenerate ~20-repetition garbled-character loop inside
  // trash.deleteConfirm.description (syntax-valid, but nonsense); attempt 2 was fluent and
  // syntax-clean but failed a back-translation round-trip on 6 of 8 strings (trash.title came
  // back as "Event", trash.deletePermanently as "Completely filled" -- near-opposite of "Delete
  // permanently" -- and trash.deleteConfirm.description as unrelated content with the {{title}}
  // placeholder dropped entirely). No stronger model was available on the host that ran this. See
  // feedback #171 for the full round-trip evidence; do not retry with qwen3-6 a third time.
  { domain: "app", locale: "dv", key: "archived.title", reason: "qwen3-6 disqualified for dv, see feedback #171", feedback: "171" },
  { domain: "app", locale: "dv", key: "archived.empty", reason: "qwen3-6 disqualified for dv, see feedback #171", feedback: "171" },
  { domain: "app", locale: "dv", key: "trash.title", reason: "qwen3-6 disqualified for dv, see feedback #171", feedback: "171" },
  { domain: "app", locale: "dv", key: "trash.empty", reason: "qwen3-6 disqualified for dv, see feedback #171", feedback: "171" },
  { domain: "app", locale: "dv", key: "trash.deletePermanently", reason: "qwen3-6 disqualified for dv, see feedback #171", feedback: "171" },
  { domain: "app", locale: "dv", key: "trash.deleteConfirm.title", reason: "qwen3-6 disqualified for dv, see feedback #171", feedback: "171" },
  { domain: "app", locale: "dv", key: "trash.deleteConfirm.description", reason: "qwen3-6 disqualified for dv, see feedback #171", feedback: "171" },
  { domain: "app", locale: "dv", key: "common.restore", reason: "qwen3-6 disqualified for dv, see feedback #171", feedback: "171" },

  // TKT-335: litellm/qwen3-6 could not complete the goal/ledger batch (21 new keys) for these 17
  // locales after 6+ resume rounds over ~2.5h -- most stayed at every key missing across every
  // round with zero progress; the batch script itself always exits 0, so this is the same
  // silent-per-locale-timeout class already on file for dv (feedback #171), not a crash or a
  // syntax/content defect. See feedback #182 for the full per-locale evidence and the corruption
  // incidents (reverted, not present in this diff) the resume rounds also produced.
  { domain: "app", locale: "zh", key: "common.add", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "zh", key: "goal.objective.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "zh", key: "goal.objective.placeholder", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "zh", key: "goal.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "zh", key: "goal.setGoal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "zh", key: "goal.acceptanceCriteria.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "zh", key: "goal.acceptanceCriteria.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "zh", key: "goal.acceptanceCriteria.met", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "zh", key: "goal.acceptanceCriteria.waive", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "zh", key: "goal.constraints.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "zh", key: "goal.constraints.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "zh", key: "goal.constraints.fromMessage", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "zh", key: "goal.status.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "zh", key: "goal.toast.objectiveRequired", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "zh", key: "goal.toast.saved", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "zh", key: "goal.ledger.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "zh", key: "goal.ledger.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "zh", key: "goal.ledger.supersede", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "zh", key: "session.tab.goal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "no", key: "common.add", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "no", key: "session.tab.goal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fi", key: "command.session.goal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fi", key: "command.session.goal.description", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fi", key: "goal.objective.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fi", key: "goal.objective.placeholder", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fi", key: "goal.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fi", key: "goal.setGoal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fi", key: "goal.acceptanceCriteria.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fi", key: "goal.acceptanceCriteria.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fi", key: "goal.acceptanceCriteria.met", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fi", key: "goal.acceptanceCriteria.waive", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fi", key: "goal.constraints.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fi", key: "goal.constraints.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fi", key: "goal.constraints.fromMessage", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fi", key: "goal.status.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fi", key: "goal.toast.objectiveRequired", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fi", key: "goal.toast.saved", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fi", key: "goal.ledger.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fi", key: "goal.ledger.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fi", key: "goal.ledger.supersede", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "am", key: "common.add", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "am", key: "command.session.goal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "am", key: "command.session.goal.description", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "am", key: "goal.objective.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "am", key: "goal.objective.placeholder", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "am", key: "goal.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "am", key: "goal.setGoal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "am", key: "goal.acceptanceCriteria.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "am", key: "goal.acceptanceCriteria.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "am", key: "goal.acceptanceCriteria.met", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "am", key: "goal.acceptanceCriteria.waive", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "am", key: "goal.constraints.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "am", key: "goal.constraints.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "am", key: "goal.constraints.fromMessage", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "am", key: "goal.status.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "am", key: "goal.toast.objectiveRequired", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "am", key: "goal.toast.saved", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "am", key: "goal.ledger.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "am", key: "goal.ledger.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "am", key: "goal.ledger.supersede", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "am", key: "session.tab.goal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bg", key: "common.add", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bg", key: "command.session.goal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bg", key: "command.session.goal.description", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bg", key: "goal.objective.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bg", key: "goal.objective.placeholder", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bg", key: "goal.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bg", key: "goal.setGoal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bg", key: "goal.acceptanceCriteria.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bg", key: "goal.acceptanceCriteria.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bg", key: "goal.acceptanceCriteria.met", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bg", key: "goal.acceptanceCriteria.waive", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bg", key: "goal.constraints.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bg", key: "goal.constraints.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bg", key: "goal.constraints.fromMessage", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bg", key: "goal.status.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bg", key: "goal.toast.objectiveRequired", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bg", key: "goal.toast.saved", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bg", key: "goal.ledger.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bg", key: "goal.ledger.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bg", key: "goal.ledger.supersede", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bg", key: "session.tab.goal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bn", key: "common.add", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bn", key: "command.session.goal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bn", key: "command.session.goal.description", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bn", key: "goal.objective.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bn", key: "goal.objective.placeholder", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bn", key: "goal.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bn", key: "goal.setGoal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bn", key: "goal.acceptanceCriteria.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bn", key: "goal.acceptanceCriteria.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bn", key: "goal.acceptanceCriteria.met", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bn", key: "goal.acceptanceCriteria.waive", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bn", key: "goal.constraints.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bn", key: "goal.constraints.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bn", key: "goal.constraints.fromMessage", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bn", key: "goal.status.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bn", key: "goal.toast.objectiveRequired", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bn", key: "goal.toast.saved", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bn", key: "goal.ledger.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bn", key: "goal.ledger.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bn", key: "goal.ledger.supersede", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "bn", key: "session.tab.goal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dv", key: "common.add", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dv", key: "goal.objective.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dv", key: "goal.objective.placeholder", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dv", key: "goal.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dv", key: "goal.setGoal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dv", key: "goal.acceptanceCriteria.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dv", key: "goal.acceptanceCriteria.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dv", key: "goal.acceptanceCriteria.met", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dv", key: "goal.acceptanceCriteria.waive", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dv", key: "goal.constraints.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dv", key: "goal.constraints.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dv", key: "goal.constraints.fromMessage", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dv", key: "goal.status.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dv", key: "goal.toast.objectiveRequired", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dv", key: "goal.toast.saved", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dv", key: "goal.ledger.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dv", key: "goal.ledger.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dv", key: "goal.ledger.supersede", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dv", key: "session.tab.goal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dz", key: "common.add", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dz", key: "command.session.goal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dz", key: "command.session.goal.description", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dz", key: "goal.objective.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dz", key: "goal.objective.placeholder", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dz", key: "goal.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dz", key: "goal.setGoal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dz", key: "goal.acceptanceCriteria.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dz", key: "goal.acceptanceCriteria.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dz", key: "goal.acceptanceCriteria.met", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dz", key: "goal.acceptanceCriteria.waive", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dz", key: "goal.constraints.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dz", key: "goal.constraints.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dz", key: "goal.constraints.fromMessage", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dz", key: "goal.status.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dz", key: "goal.toast.objectiveRequired", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dz", key: "goal.toast.saved", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dz", key: "goal.ledger.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dz", key: "goal.ledger.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dz", key: "goal.ledger.supersede", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "dz", key: "session.tab.goal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fo", key: "common.add", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fo", key: "command.session.goal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fo", key: "command.session.goal.description", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fo", key: "goal.objective.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fo", key: "goal.objective.placeholder", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fo", key: "goal.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fo", key: "goal.setGoal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fo", key: "goal.acceptanceCriteria.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fo", key: "goal.acceptanceCriteria.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fo", key: "goal.acceptanceCriteria.met", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fo", key: "goal.acceptanceCriteria.waive", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fo", key: "goal.constraints.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fo", key: "goal.constraints.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fo", key: "goal.constraints.fromMessage", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fo", key: "goal.status.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fo", key: "goal.toast.objectiveRequired", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fo", key: "goal.toast.saved", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fo", key: "goal.ledger.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fo", key: "goal.ledger.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fo", key: "goal.ledger.supersede", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "fo", key: "session.tab.goal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "hy", key: "common.add", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "hy", key: "command.session.goal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "hy", key: "command.session.goal.description", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "hy", key: "goal.objective.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "hy", key: "goal.objective.placeholder", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "hy", key: "goal.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "hy", key: "goal.setGoal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "hy", key: "goal.acceptanceCriteria.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "hy", key: "goal.acceptanceCriteria.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "hy", key: "goal.acceptanceCriteria.met", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "hy", key: "goal.acceptanceCriteria.waive", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "hy", key: "goal.constraints.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "hy", key: "goal.constraints.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "hy", key: "goal.constraints.fromMessage", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "hy", key: "goal.status.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "hy", key: "goal.toast.objectiveRequired", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "hy", key: "goal.toast.saved", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "hy", key: "goal.ledger.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "hy", key: "goal.ledger.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "hy", key: "goal.ledger.supersede", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "hy", key: "session.tab.goal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "is", key: "common.add", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "is", key: "command.session.goal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "is", key: "command.session.goal.description", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "is", key: "goal.objective.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "is", key: "goal.objective.placeholder", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "is", key: "goal.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "is", key: "goal.setGoal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "is", key: "goal.acceptanceCriteria.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "is", key: "goal.acceptanceCriteria.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "is", key: "goal.acceptanceCriteria.met", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "is", key: "goal.acceptanceCriteria.waive", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "is", key: "goal.constraints.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "is", key: "goal.constraints.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "is", key: "goal.constraints.fromMessage", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "is", key: "goal.status.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "is", key: "goal.toast.objectiveRequired", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "is", key: "goal.toast.saved", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "is", key: "goal.ledger.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "is", key: "goal.ledger.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "is", key: "goal.ledger.supersede", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "is", key: "session.tab.goal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "lv", key: "common.add", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "lv", key: "command.session.goal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "lv", key: "command.session.goal.description", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "lv", key: "goal.objective.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "lv", key: "goal.objective.placeholder", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "lv", key: "goal.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "lv", key: "goal.setGoal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "lv", key: "goal.acceptanceCriteria.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "lv", key: "goal.acceptanceCriteria.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "lv", key: "goal.acceptanceCriteria.met", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "lv", key: "goal.acceptanceCriteria.waive", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "lv", key: "goal.constraints.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "lv", key: "goal.constraints.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "lv", key: "goal.constraints.fromMessage", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "lv", key: "goal.status.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "lv", key: "goal.toast.objectiveRequired", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "lv", key: "goal.toast.saved", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "lv", key: "goal.ledger.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "lv", key: "goal.ledger.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "lv", key: "goal.ledger.supersede", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "lv", key: "session.tab.goal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "mk", key: "common.add", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "mk", key: "command.session.goal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "mk", key: "command.session.goal.description", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "mk", key: "goal.objective.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "mk", key: "goal.objective.placeholder", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "mk", key: "goal.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "mk", key: "goal.setGoal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "mk", key: "goal.acceptanceCriteria.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "mk", key: "goal.acceptanceCriteria.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "mk", key: "goal.acceptanceCriteria.met", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "mk", key: "goal.acceptanceCriteria.waive", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "mk", key: "goal.constraints.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "mk", key: "goal.constraints.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "mk", key: "goal.constraints.fromMessage", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "mk", key: "goal.status.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "mk", key: "goal.toast.objectiveRequired", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "mk", key: "goal.toast.saved", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "mk", key: "goal.ledger.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "mk", key: "goal.ledger.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "mk", key: "goal.ledger.supersede", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "mk", key: "session.tab.goal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "mn", key: "common.add", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "mn", key: "session.tab.goal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "my", key: "common.add", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "my", key: "command.session.goal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "my", key: "command.session.goal.description", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "my", key: "goal.objective.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "my", key: "goal.objective.placeholder", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "my", key: "goal.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "my", key: "goal.setGoal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "my", key: "goal.acceptanceCriteria.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "my", key: "goal.acceptanceCriteria.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "my", key: "goal.acceptanceCriteria.met", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "my", key: "goal.acceptanceCriteria.waive", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "my", key: "goal.constraints.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "my", key: "goal.constraints.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "my", key: "goal.constraints.fromMessage", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "my", key: "goal.status.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "my", key: "goal.toast.objectiveRequired", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "my", key: "goal.toast.saved", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "my", key: "goal.ledger.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "my", key: "goal.ledger.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "my", key: "goal.ledger.supersede", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "my", key: "session.tab.goal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "sr", key: "common.add", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "sr", key: "command.session.goal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "sr", key: "command.session.goal.description", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "sr", key: "goal.objective.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "sr", key: "goal.objective.placeholder", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "sr", key: "goal.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "sr", key: "goal.setGoal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "sr", key: "goal.acceptanceCriteria.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "sr", key: "goal.acceptanceCriteria.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "sr", key: "goal.acceptanceCriteria.met", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "sr", key: "goal.acceptanceCriteria.waive", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "sr", key: "goal.constraints.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "sr", key: "goal.constraints.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "sr", key: "goal.constraints.fromMessage", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "sr", key: "goal.status.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "sr", key: "goal.toast.objectiveRequired", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "sr", key: "goal.toast.saved", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "sr", key: "goal.ledger.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "sr", key: "goal.ledger.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "sr", key: "goal.ledger.supersede", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "sr", key: "session.tab.goal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "tg", key: "common.add", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "tg", key: "goal.objective.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "tg", key: "goal.objective.placeholder", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "tg", key: "goal.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "tg", key: "goal.setGoal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "tg", key: "goal.acceptanceCriteria.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "tg", key: "goal.acceptanceCriteria.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "tg", key: "goal.acceptanceCriteria.met", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "tg", key: "goal.acceptanceCriteria.waive", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "tg", key: "goal.constraints.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "tg", key: "goal.constraints.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "tg", key: "goal.constraints.fromMessage", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "tg", key: "goal.status.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "tg", key: "goal.toast.objectiveRequired", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "tg", key: "goal.toast.saved", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "tg", key: "goal.ledger.title", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "tg", key: "goal.ledger.empty", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "tg", key: "goal.ledger.supersede", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
  { domain: "app", locale: "tg", key: "session.tab.goal", reason: "qwen3-6 timed out on TKT-335's goal/ledger batch, see feedback #182", feedback: "182" },
]

describe("i18n parity", () => {
  test("non-English locales have every English key and required plural variants", async () => {
    for (const domain of domains) {
      const source = await dictionary(domain.source)
      for (const locale of domain.locales) {
        const target = await dictionary(domain.target(locale))
        const excepted = new Set(
          KNOWN_MISSING.filter((entry) => entry.domain === domain.name && entry.locale === locale).map(
            (entry) => entry.key,
          ),
        )
        const missing = Object.keys(source).filter((key) => !Object.hasOwn(target, key) && !excepted.has(key))
        const extra = Object.keys(target)
          .filter((key) => !Object.hasOwn(source, key))
          .sort()
        const expected = pluralFamilies(source)
          .flatMap((key) => (pluralCategories.get(locale) ?? []).map((category) => `${key}.${category}`))
          .sort()
        expect({ domain: domain.name, locale, missing, extra }).toEqual({
          domain: domain.name,
          locale,
          missing: [],
          extra: expected,
        })
      }
    }
  })

  test("non-English locales preserve English placeholders", async () => {
    for (const domain of domains) {
      const source = await dictionary(domain.source)
      for (const locale of domain.locales) {
        const target = await dictionary(domain.target(locale))
        const mismatched = Object.keys(source).filter(
          (key) => Object.hasOwn(target, key) && placeholders(source[key]).join() !== placeholders(target[key]).join(),
        )
        const pluralMismatched = pluralFamilies(source).flatMap((key) =>
          (pluralCategories.get(locale) ?? [])
            .map((category) => `${key}.${category}`)
            .filter((variant) => placeholders(source[`${key}.other`]).join() !== placeholders(target[variant]).join()),
        )
        expect({ domain: domain.name, locale, mismatched, pluralMismatched }).toEqual({
          domain: domain.name,
          locale,
          mismatched: [],
          pluralMismatched: [],
        })
      }
    }
  })

  test("non-English locales translate targeted unseen session keys", async () => {
    const source = await dictionary("./en.ts")
    for (const locale of appLocales) {
      const target = await dictionary(`./${locale}.ts`)
      for (const key of ["command.session.previous.unseen", "command.session.next.unseen"]) {
        expect(target[key]).toBeDefined()
        expect(target[key]).not.toBe(source[key])
      }
    }
  })

  test("changed-file summary keys preserve rendered English copy and localize complete phrases", async () => {
    const source = await dictionary("../../../ui/src/i18n/en.ts")
    expect(source["ui.sessionTurn.diffs.changed.one"].replace("{{count}}", "1")).toBe("1 Changed file")
    expect(source["ui.sessionTurn.diffs.changed.other"].replace("{{count}}", "2")).toBe("2 Changed files")
    expect(source["ui.sessionTurn.diffs.changed"]).toBeUndefined()

    for (const locale of appLocales) {
      const target = await dictionary(`../../../ui/src/i18n/${locale}.ts`)
      for (const key of ["ui.sessionTurn.diffs.changed.one", "ui.sessionTurn.diffs.changed.other"]) {
        expect(target[key].trim()).not.toBe("")
        expect(placeholders(target[key])).toEqual(["count"])
      }
    }
  })
})

describe("i18n plural parity", () => {
  test("locale-specific categories exist and preserve count placeholders", async () => {
    for (const domain of domains.slice(0, 2)) {
      const source = await dictionary(domain.source)
      const families = pluralFamilies(source)
      for (const locale of domain.locales) {
        const target = await dictionary(domain.target(locale))
        const missing = families.flatMap((key) =>
          (pluralCategories.get(locale) ?? [])
            .map((category) => `${key}.${category}`)
            .filter((variant) => !Object.hasOwn(target, variant)),
        )
        const mismatched = families.flatMap((key) =>
          (pluralCategories.get(locale) ?? [])
            .map((category) => `${key}.${category}`)
            .filter(
              (variant) =>
                Object.hasOwn(target, variant) &&
                placeholders(source[`${key}.other`]).join() !== placeholders(target[variant]).join(),
            ),
        )
        expect({ domain: domain.name, locale, missing, mismatched }).toEqual({
          domain: domain.name,
          locale,
          missing: [],
          mismatched: [],
        })
      }
    }
  })
})

async function dictionary(file: string) {
  const module: unknown = await import(file)
  if (typeof module !== "object" || module === null || !("dict" in module) || !isDictionary(module.dict)) {
    throw new Error(`Invalid translation dictionary: ${file}`)
  }
  return module.dict
}

function isDictionary(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  return Object.values(value).every((item) => typeof item === "string")
}

function placeholders(value: string) {
  return Array.from(value.matchAll(/{{\s*([^}]+?)\s*}}/g), (match) => match[1]).sort()
}

function pluralFamilies(dictionary: Record<string, string>) {
  return Object.keys(dictionary)
    .filter(
      (key) =>
        key.endsWith(".one") &&
        dictionary[key].includes("{{count}}") &&
        dictionary[`${key.slice(0, -4)}.other`]?.includes("{{count}}"),
    )
    .map((key) => key.slice(0, -4))
}
