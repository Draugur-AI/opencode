import { A } from "@solidjs/router"
import { LanguagePicker } from "~/component/language-picker"
import { useI18n } from "~/context/i18n"
import { useLanguage } from "~/context/language"

export function Legal() {
  const i18n = useI18n()
  const language = useLanguage()
  return (
    <div data-component="legal">
      {/* Copyright line removed (TKT-396 item 6, Ethan's ruling): it named "Anomaly" as the
          copyright holder, site-wide (homepage, every workspace page, /brand) -- a false
          attribution, worse than none. Authoring the replacement is Sean's, not this PR's. */}
      <span>
        <A href={language.route("/brand")}>{i18n.t("legal.brand")}</A>
      </span>
      <span>
        <LanguagePicker align="right" />
      </span>
    </div>
  )
}
