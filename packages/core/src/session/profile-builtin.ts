export * as SessionProfileBuiltin from "./profile-builtin"

import { SessionProfile } from "./profile"

/**
 * Coding and chat, per the build post's "Profiles: persist behavior, not just a label". Neither
 * is a database row -- Profile.Definition authoring is a Core Config concern (config-document
 * writer, slice 8), out of this ticket's core-first scope. These two are hardcoded so a session
 * has something to resolve against before that lands.
 *
 * Deny-only, matching SessionProfile.RuleMap's semantics (see session-profile.ts's RuleEffect
 * doc): coding lists nothing because "normal tool surface" IS the absence of a restriction, not
 * an explicit allow of everything. `task` is included in chat's denial even though no V2 core
 * tool currently registers under that action -- packages/core/src/tool/ has no task/subagent-
 * delegation tool yet (still V1-only), so the entry is inert today and becomes load-bearing the
 * moment that migration lands, without anyone needing to remember to come back and add it.
 */
export const coding: SessionProfile.Definition = {
  id: SessionProfile.ID.make("profile_coding"),
  title: "Coding",
  toolRules: {},
  skillRules: {},
  mcpRules: {},
  pluginRules: {},
  hookRules: {},
  monitorRules: { allowUser: true, allowPlugin: true, autoStart: true },
}

export const chat: SessionProfile.Definition = {
  id: SessionProfile.ID.make("profile_chat"),
  title: "Chat",
  toolRules: { edit: "deny", bash: "deny", task: "deny" },
  skillRules: {},
  mcpRules: {},
  pluginRules: {},
  hookRules: {},
  monitorRules: { allowUser: false, allowPlugin: false, autoStart: false },
}
