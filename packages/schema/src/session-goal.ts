export * as SessionGoal from "./session-goal"

import { Schema } from "effect"
import { DateTimeUtcFromMillis, NonNegativeInt, optional } from "./schema"
import { SessionID } from "./session-id"
import { SessionMessage } from "./session-message"

export const CriterionID = Schema.String.pipe(Schema.brand("Session.Goal.CriterionID"))
export type CriterionID = typeof CriterionID.Type

export const CriterionStatus = Schema.Literals(["open", "met", "waived"])
export type CriterionStatus = typeof CriterionStatus.Type

export interface AcceptanceCriterion extends Schema.Schema.Type<typeof AcceptanceCriterion> {}
export const AcceptanceCriterion = Schema.Struct({
  id: CriterionID,
  text: Schema.String,
  status: CriterionStatus,
}).annotate({ identifier: "Session.Goal.AcceptanceCriterion" })

export const ConstraintID = Schema.String.pipe(Schema.brand("Session.Goal.ConstraintID"))
export type ConstraintID = typeof ConstraintID.Type

export interface Constraint extends Schema.Schema.Type<typeof Constraint> {}
export const Constraint = Schema.Struct({
  id: ConstraintID,
  text: Schema.String,
  sourceMessageID: SessionMessage.ID.pipe(optional),
}).annotate({ identifier: "Session.Goal.Constraint" })

export const Status = Schema.Literals(["active", "achieved", "abandoned"])
export type Status = typeof Status.Type

// The user's own words for the objective and every constraint, plus the acceptance criteria
// that gate completion. Not conversation text -- a typed, versioned value the runner re-renders
// deterministically every turn, so it cannot be lost to summarization the way prose can.
export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  sessionID: SessionID,
  objective: Schema.String,
  acceptanceCriteria: Schema.Array(AcceptanceCriterion),
  constraints: Schema.Array(Constraint),
  status: Status,
  sourceMessageIDs: Schema.Array(SessionMessage.ID),
  version: NonNegativeInt,
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
  }),
}).annotate({ identifier: "Session.Goal.Info" })
