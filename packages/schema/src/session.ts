export * as Session from "./session"

import { Schema } from "effect"
import { Agent } from "./agent"
import { Location } from "./location"
import { Model } from "./model"
import { Project } from "./project"
import { DateTimeUtcFromMillis, NonNegativeInt, optional, RelativePath } from "./schema"
import { SessionEvent } from "./session-event"
import { SessionID } from "./session-id"
import { SessionLifecycle } from "./session-lifecycle"
import { Revert } from "./revert"

export const ID = SessionID
export type ID = SessionID

export const Event = SessionEvent

export const Lifecycle = SessionLifecycle.Value
export type Lifecycle = SessionLifecycle.Value
export const LifecycleFilter = SessionLifecycle.Filter
export type LifecycleFilter = SessionLifecycle.Filter
export const Tombstone = SessionLifecycle.Tombstone
export type Tombstone = SessionLifecycle.Tombstone

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  parentID: ID.pipe(optional),
  projectID: Project.ID,
  agent: Agent.ID.pipe(optional),
  model: Model.Ref.pipe(optional),
  cost: Schema.Finite,
  tokens: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cache: Schema.Struct({
      read: Schema.Finite,
      write: Schema.Finite,
    }),
  }),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    /** @deprecated Read `lifecycle` instead. Retained for the V1 compatibility window. */
    archived: DateTimeUtcFromMillis.pipe(optional),
  }),
  lifecycle: SessionLifecycle.Value,
  /**
   * The aggregate sequence of the event that last changed `lifecycle`. Monotonic per session, and
   * the value a client compares to decide whether a delivered event is newer than what it holds.
   */
  lifecycleRevision: NonNegativeInt,
  title: Schema.String,
  location: Location.Ref,
  subpath: RelativePath.pipe(optional),
  revert: Revert.State.pipe(optional),
}).annotate({ identifier: "SessionV2.Info" })

export const ListAnchor = Schema.Struct({
  id: ID,
  time: Schema.Finite,
  direction: Schema.Literals(["previous", "next"]),
}).annotate({ identifier: "Session.ListAnchor" })
export interface ListAnchor extends Schema.Schema.Type<typeof ListAnchor> {}
