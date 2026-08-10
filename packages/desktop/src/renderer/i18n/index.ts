import * as i18n from "@solid-primitives/i18n"
import {
  DESKTOP_NATIVE_LOCALES,
  detectDesktopNativeLocale,
  type DesktopNativeLocale,
} from "../../../../app/src/i18n/desktop-native"

import { dict as appEn } from "../../../../app/src/i18n/en"
import { dict as desktopEn } from "./en"

export type Locale = DesktopNativeLocale

type RawDictionary = typeof appEn & typeof desktopEn
type Dictionary = Record<keyof i18n.Flatten<RawDictionary>, string>

function detectLocale(): Locale {
  if (typeof navigator !== "object") return "en"
  return detectDesktopNativeLocale(navigator.languages?.length ? navigator.languages : [navigator.language])
}

function parseLocale(value: unknown): Locale | null {
  if (!value) return null
  if (typeof value !== "string") return null
  if ((DESKTOP_NATIVE_LOCALES as readonly string[]).includes(value)) return value as Locale
  return null
}

function parseRecord(value: unknown) {
  if (!value || typeof value !== "object") return null
  if (Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function parseStored(value: unknown) {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function pickLocale(value: unknown): Locale | null {
  const direct = parseLocale(value)
  if (direct) return direct

  const record = parseRecord(value)
  if (!record) return null

  return parseLocale(record.locale)
}

const base = i18n.flatten({ ...appEn, ...desktopEn })

const loaders = {
  zh: () => Promise.all([import("../../../../app/src/i18n/zh"), import("./zh")]),
  zht: () => Promise.all([import("../../../../app/src/i18n/zht"), import("./zht")]),
  ko: () => Promise.all([import("../../../../app/src/i18n/ko"), import("./ko")]),
  de: () => Promise.all([import("../../../../app/src/i18n/de"), import("./de")]),
  es: () => Promise.all([import("../../../../app/src/i18n/es"), import("./es")]),
  fr: () => Promise.all([import("../../../../app/src/i18n/fr"), import("./fr")]),
  da: () => Promise.all([import("../../../../app/src/i18n/da"), import("./da")]),
  ja: () => Promise.all([import("../../../../app/src/i18n/ja"), import("./ja")]),
  pl: () => Promise.all([import("../../../../app/src/i18n/pl"), import("./pl")]),
  ru: () => Promise.all([import("../../../../app/src/i18n/ru"), import("./ru")]),
  uk: () => Promise.all([import("../../../../app/src/i18n/uk"), import("./uk")]),
  bs: () => Promise.all([import("../../../../app/src/i18n/bs"), import("./bs")]),
  ar: () => Promise.all([import("../../../../app/src/i18n/ar"), import("./ar")]),
  no: () => Promise.all([import("../../../../app/src/i18n/no"), import("./no")]),
  br: () => Promise.all([import("../../../../app/src/i18n/br"), import("./br")]),
  th: () => Promise.all([import("../../../../app/src/i18n/th"), import("./th")]),
  tr: () => Promise.all([import("../../../../app/src/i18n/tr"), import("./tr")]),
  hi: () => Promise.all([import("../../../../app/src/i18n/hi"), import("./hi")]),
  nl: () => Promise.all([import("../../../../app/src/i18n/nl"), import("./nl")]),
  id: () => Promise.all([import("../../../../app/src/i18n/id"), import("./id")]),
  vi: () => Promise.all([import("../../../../app/src/i18n/vi"), import("./vi")]),
  it: () => Promise.all([import("../../../../app/src/i18n/it"), import("./it")]),
  ur: () => Promise.all([import("../../../../app/src/i18n/ur"), import("./ur")]),
  pa: () => Promise.all([import("../../../../app/src/i18n/pa"), import("./pa")]),
  az: () => Promise.all([import("../../../../app/src/i18n/az"), import("./az")]),
  fi: () => Promise.all([import("../../../../app/src/i18n/fi"), import("./fi")]),
  sv: () => Promise.all([import("../../../../app/src/i18n/sv"), import("./sv")]),
  am: () => Promise.all([import("../../../../app/src/i18n/am"), import("./am")]),
  bg: () => Promise.all([import("../../../../app/src/i18n/bg"), import("./bg")]),
  bn: () => Promise.all([import("../../../../app/src/i18n/bn"), import("./bn")]),
  ca: () => Promise.all([import("../../../../app/src/i18n/ca"), import("./ca")]),
  cs: () => Promise.all([import("../../../../app/src/i18n/cs"), import("./cs")]),
  dv: () => Promise.all([import("../../../../app/src/i18n/dv"), import("./dv")]),
  dz: () => Promise.all([import("../../../../app/src/i18n/dz"), import("./dz")]),
  el: () => Promise.all([import("../../../../app/src/i18n/el"), import("./el")]),
  et: () => Promise.all([import("../../../../app/src/i18n/et"), import("./et")]),
  fa: () => Promise.all([import("../../../../app/src/i18n/fa"), import("./fa")]),
  fo: () => Promise.all([import("../../../../app/src/i18n/fo"), import("./fo")]),
  hr: () => Promise.all([import("../../../../app/src/i18n/hr"), import("./hr")]),
  hu: () => Promise.all([import("../../../../app/src/i18n/hu"), import("./hu")]),
  hy: () => Promise.all([import("../../../../app/src/i18n/hy"), import("./hy")]),
  is: () => Promise.all([import("../../../../app/src/i18n/is"), import("./is")]),
  ka: () => Promise.all([import("../../../../app/src/i18n/ka"), import("./ka")]),
  km: () => Promise.all([import("../../../../app/src/i18n/km"), import("./km")]),
  lo: () => Promise.all([import("../../../../app/src/i18n/lo"), import("./lo")]),
  lt: () => Promise.all([import("../../../../app/src/i18n/lt"), import("./lt")]),
  lv: () => Promise.all([import("../../../../app/src/i18n/lv"), import("./lv")]),
  mk: () => Promise.all([import("../../../../app/src/i18n/mk"), import("./mk")]),
  mn: () => Promise.all([import("../../../../app/src/i18n/mn"), import("./mn")]),
  ms: () => Promise.all([import("../../../../app/src/i18n/ms"), import("./ms")]),
  my: () => Promise.all([import("../../../../app/src/i18n/my"), import("./my")]),
  ne: () => Promise.all([import("../../../../app/src/i18n/ne"), import("./ne")]),
  ro: () => Promise.all([import("../../../../app/src/i18n/ro"), import("./ro")]),
  si: () => Promise.all([import("../../../../app/src/i18n/si"), import("./si")]),
  sk: () => Promise.all([import("../../../../app/src/i18n/sk"), import("./sk")]),
  sl: () => Promise.all([import("../../../../app/src/i18n/sl"), import("./sl")]),
  sq: () => Promise.all([import("../../../../app/src/i18n/sq"), import("./sq")]),
  sr: () => Promise.all([import("../../../../app/src/i18n/sr"), import("./sr")]),
  tg: () => Promise.all([import("../../../../app/src/i18n/tg"), import("./tg")]),
  tk: () => Promise.all([import("../../../../app/src/i18n/tk"), import("./tk")]),
  uz: () => Promise.all([import("../../../../app/src/i18n/uz"), import("./uz")]),
}

async function build(locale: Locale): Promise<Dictionary> {
  if (locale === "en") return base
  const dictionaries = await loaders[locale]()
  return { ...base, ...i18n.flatten(dictionaries[0].dict), ...i18n.flatten(dictionaries[1].dict) }
}

const state = {
  locale: detectLocale(),
  dict: base as Dictionary,
  init: undefined as Promise<Locale> | undefined,
}

const translate = i18n.translator(() => state.dict, i18n.resolveTemplate)

export function t(key: keyof Dictionary, params?: Record<string, string | number>) {
  return translate(key, params)
}

export function initI18n(): Promise<Locale> {
  const cached = state.init
  if (cached) return cached

  const promise = (async () => {
    const raw = await window.api.storeGet("opencode.global.dat", "language").catch(() => null)
    const value = parseStored(raw)
    const next = pickLocale(value) ?? state.locale

    state.locale = next
    state.dict = await build(next)
    return next
  })().catch(() => state.locale)

  state.init = promise
  return promise
}
