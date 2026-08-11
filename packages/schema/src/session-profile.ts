export * as SessionProfile from "./session-profile"

import { Schema } from "effect"
import { ascending } from "./identifier"
import { DateTimeUtcFromMillis, optional, statics } from "./schema"

// A rule is deliberately deny-biased: "inherit" and "allow" are treated identically by every
// consumer of a resolved snapshot (see packages/core/src/permission.ts's profile-rule merge) --
// neither can loosen what a higher-scoped ruleset already denies. Only "deny" ever emits an
// additional restriction. The three-state type exists for authoring clarity (a profile author can
// write "allow" to document an explicit carve-out even though it has no different runtime effect
// from "inherit" today), not because "allow" grants anything "inherit" does not.
export const RuleEffect = Schema.Literals(["inherit", "allow", "deny"])
export type RuleEffect = typeof RuleEffect.Type

export const RuleMap = Schema.Record(Schema.String, RuleEffect)
export type RuleMap = typeof RuleMap.Type

export const MonitorRules = Schema.Struct({
  allowUser: Schema.Boolean,
  allowPlugin: Schema.Boolean,
  autoStart: Schema.Boolean,
}).annotate({ identifier: "Session.Profile.MonitorRules" })
export type MonitorRules = typeof MonitorRules.Type

export const ID = Schema.String.check(Schema.isStartsWith("profile_")).pipe(
  Schema.brand("Session.Profile.ID"),
  statics((schema) => ({ create: () => schema.make("profile_" + ascending()) })),
)
export type ID = typeof ID.Type

// A profile is not a new agent -- it composes the existing agent choice with a policy overlay.
// `agent` left unset means the profile does not constrain agent choice at all.
export interface Definition extends Schema.Schema.Type<typeof Definition> {}
export const Definition = Schema.Struct({
  id: ID,
  title: Schema.String,
  agent: Schema.String.pipe(optional),
  toolRules: RuleMap,
  skillRules: RuleMap,
  mcpRules: RuleMap,
  pluginRules: RuleMap,
  hookRules: RuleMap,
  monitorRules: MonitorRules,
  compaction: Schema.String.pipe(optional),
  systemAppend: Schema.String.pipe(optional),
}).annotate({ identifier: "Session.Profile.Definition" })

export const SnapshotID = Schema.String.check(Schema.isStartsWith("profsnap_")).pipe(
  Schema.brand("Session.Profile.SnapshotID"),
  statics((schema) => ({ create: () => schema.make("profsnap_" + ascending()) })),
)
export type SnapshotID = typeof SnapshotID.Type

// Immutable: a resolved copy of the definition's rules at the moment a session created or
// switched to it. Old turns stay explainable against the snapshot they actually ran under even if
// the named definition changes (or is deleted) later -- the snapshot never re-reads the
// definition. `definitionHash` lets a caller detect "this session is running a stale resolution
// of a still-existing definition" without comparing every rule field by hand.
export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}
export const Snapshot = Schema.Struct({
  id: SnapshotID,
  definitionID: ID,
  definitionHash: Schema.String,
  title: Schema.String,
  agent: Schema.String.pipe(optional),
  toolRules: RuleMap,
  skillRules: RuleMap,
  mcpRules: RuleMap,
  pluginRules: RuleMap,
  hookRules: RuleMap,
  monitorRules: MonitorRules,
  compaction: Schema.String.pipe(optional),
  systemAppend: Schema.String.pipe(optional),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
  }),
}).annotate({ identifier: "Session.Profile.Snapshot" })
