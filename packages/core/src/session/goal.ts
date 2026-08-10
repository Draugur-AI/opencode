export * as SessionGoal from "./goal"

import { and, eq } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { SessionGoal as GoalSchema } from "@opencode-ai/schema/session-goal"
import { NonNegativeInt } from "@opencode-ai/schema/schema"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { SystemContext } from "../system-context/index"
import { SessionSchema } from "./schema"
import { SessionEvent } from "./event"
import { SessionGoalTable } from "./sql"
import type { SessionMessage } from "./message"

type DatabaseService = Database.Interface["db"]

export const Info = GoalSchema.Info
export type Info = typeof Info.Type
export const CriterionID = GoalSchema.CriterionID
export type CriterionID = typeof CriterionID.Type
export const AcceptanceCriterion = GoalSchema.AcceptanceCriterion
export type AcceptanceCriterion = typeof AcceptanceCriterion.Type
export const ConstraintID = GoalSchema.ConstraintID
export type ConstraintID = typeof ConstraintID.Type
export const Constraint = GoalSchema.Constraint
export type Constraint = typeof Constraint.Type
export const Status = GoalSchema.Status
export type Status = typeof Status.Type

type Row = typeof SessionGoalTable.$inferSelect

const fromRow = (row: Row): Info => ({
  sessionID: row.session_id,
  objective: row.objective,
  acceptanceCriteria: row.acceptance_criteria,
  constraints: row.constraints,
  status: row.status,
  sourceMessageIDs: row.source_message_ids,
  version: row.version,
  time: { created: DateTime.makeUnsafe(row.time_created), updated: DateTime.makeUnsafe(row.time_updated) },
})

/**
 * Raised when the row no longer looks the way the caller believed it did -- a stale
 * `expectedVersion`. Thrown as a defect from inside the commit transaction so the whole event
 * rolls back rather than committing against a row it does not describe; the service converts it
 * to a typed error. Mirrors SessionLifecycle.Conflict (session/lifecycle.ts).
 */
export class Conflict extends Schema.TaggedErrorClass<Conflict>()("SessionGoal.Conflict", {
  sessionID: SessionSchema.ID,
  expectedVersion: NonNegativeInt.pipe(Schema.optional),
}) {}

/**
 * Apply one committed `GoalUpdated` event: an atomic replacement of objective/criteria/constraints.
 * Upsert because a goal may not exist yet -- creation and update are the same operation, gated the
 * same way. Runs inside the durable event transaction (see event.ts's atomic commit mechanism), so
 * this compare-and-set is authoritative: losing it rolls the event back.
 */
export const projectUpdated = Effect.fn("SessionGoal.projectUpdated")(function* (
  db: DatabaseService,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly objective: string
    readonly acceptanceCriteria: ReadonlyArray<AcceptanceCriterion>
    readonly constraints: ReadonlyArray<Constraint>
    readonly sourceMessageIDs: ReadonlyArray<SessionMessage.ID>
    readonly expectedVersion?: number
    /** The aggregate sequence this event committed at. */
    readonly aggregateSeq: number
    readonly timestamp: DateTime.Utc
  },
) {
  // One past the aggregate sequence, same convention as SessionLifecycle.project: revision 0 means
  // "no goal mutation has been committed yet", never "changed once".
  const version = input.aggregateSeq + 1
  const now = DateTime.toEpochMillis(input.timestamp)
  const updated = yield* db
    .insert(SessionGoalTable)
    .values({
      session_id: input.sessionID,
      objective: input.objective,
      acceptance_criteria: [...input.acceptanceCriteria],
      constraints: [...input.constraints],
      status: "active",
      source_message_ids: [...input.sourceMessageIDs],
      version,
      time_created: now,
      time_updated: now,
    })
    .onConflictDoUpdate({
      target: SessionGoalTable.session_id,
      set: {
        objective: input.objective,
        acceptance_criteria: [...input.acceptanceCriteria],
        constraints: [...input.constraints],
        source_message_ids: [...input.sourceMessageIDs],
        version,
        time_updated: now,
      },
      // Absent expectedVersion means an unconditional write (matches SessionLifecycle.project).
      where: input.expectedVersion === undefined ? undefined : eq(SessionGoalTable.version, input.expectedVersion),
    })
    .returning({ session_id: SessionGoalTable.session_id })
    .get()
    .pipe(Effect.orDie)
  if (!updated) return yield* Effect.die(new Conflict({ sessionID: input.sessionID, expectedVersion: input.expectedVersion }))
})

/** Apply one committed `GoalStatusChanged` event. The goal must already exist. */
export const projectStatusChanged = Effect.fn("SessionGoal.projectStatusChanged")(function* (
  db: DatabaseService,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly status: Status
    readonly expectedVersion?: number
    readonly aggregateSeq: number
    readonly timestamp: DateTime.Utc
  },
) {
  const version = input.aggregateSeq + 1
  const now = DateTime.toEpochMillis(input.timestamp)
  const updated = yield* db
    .update(SessionGoalTable)
    .set({ status: input.status, version, time_updated: now })
    .where(
      and(
        eq(SessionGoalTable.session_id, input.sessionID),
        ...(input.expectedVersion === undefined ? [] : [eq(SessionGoalTable.version, input.expectedVersion)]),
      ),
    )
    .returning({ session_id: SessionGoalTable.session_id })
    .get()
    .pipe(Effect.orDie)
  if (!updated) return yield* Effect.die(new Conflict({ sessionID: input.sessionID, expectedVersion: input.expectedVersion }))
})

export interface Interface {
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<Info | undefined>
  readonly update: (input: {
    readonly sessionID: SessionSchema.ID
    readonly objective: string
    readonly acceptanceCriteria: ReadonlyArray<AcceptanceCriterion>
    readonly constraints: ReadonlyArray<Constraint>
    readonly sourceMessageIDs: ReadonlyArray<SessionMessage.ID>
    readonly expectedVersion?: number
  }) => Effect.Effect<Info, Conflict>
  readonly setStatus: (input: {
    readonly sessionID: SessionSchema.ID
    readonly status: Status
    readonly expectedVersion?: number
  }) => Effect.Effect<Info, Conflict>
  /** A session-scoped SystemContext source: the goal re-rendered every turn from durable state,
   * never from the compaction summary. Not registered into the location-wide SystemContextRegistry
   * -- called directly by the runner with the active sessionID, alongside skill/reference guidance. */
  readonly context: (sessionID: SessionSchema.ID) => Effect.Effect<SystemContext.SystemContext>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionGoal") {}

const render = (goal: Info) =>
  [
    "<session_goal>",
    `  <objective>${goal.objective}</objective>`,
    `  <status>${goal.status}</status>`,
    ...(goal.constraints.length === 0
      ? []
      : [
          "  <constraints>",
          ...goal.constraints.map((c) => `    <constraint id="${c.id}">${c.text}</constraint>`),
          "  </constraints>",
        ]),
    ...(goal.acceptanceCriteria.length === 0
      ? []
      : [
          "  <acceptance_criteria>",
          ...goal.acceptanceCriteria.map(
            (c) => `    <criterion id="${c.id}" status="${c.status}">${c.text}</criterion>`,
          ),
          "  </acceptance_criteria>",
        ]),
    "</session_goal>",
    "The goal above is durable state, not conversation recall. It survives compaction exactly as",
    "written. Do not report the objective complete while an acceptance criterion is still open.",
  ].join("\n")

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service

    const get: Interface["get"] = Effect.fn("SessionGoal.get")(function* (sessionID) {
      const row = yield* db
        .select()
        .from(SessionGoalTable)
        .where(eq(SessionGoalTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      return row ? fromRow(row) : undefined
    })

    const result = Effect.fn("SessionGoal.result")(function* (sessionID: SessionSchema.ID) {
      const row = yield* get(sessionID)
      if (!row) return yield* Effect.die(`Goal projection missing for ${sessionID} immediately after commit`)
      return row
    })

    const update: Interface["update"] = Effect.fn("SessionGoal.update")(function* (input) {
      const now = yield* DateTime.now
      yield* events
        .publish(SessionEvent.GoalUpdated, {
          sessionID: input.sessionID,
          timestamp: now,
          objective: input.objective,
          acceptanceCriteria: input.acceptanceCriteria,
          constraints: input.constraints,
          sourceMessageIDs: input.sourceMessageIDs,
          expectedVersion: input.expectedVersion,
        })
        .pipe(
          Effect.catchDefect((defect) => {
            if (defect instanceof Conflict)
              return get(input.sessionID).pipe(
                Effect.flatMap(
                  (current) => new Conflict({ sessionID: input.sessionID, expectedVersion: current?.version ?? 0 }),
                ),
              )
            return Effect.die(defect)
          }),
        )
      return yield* result(input.sessionID)
    })

    const setStatus: Interface["setStatus"] = Effect.fn("SessionGoal.setStatus")(function* (input) {
      const now = yield* DateTime.now
      yield* events
        .publish(SessionEvent.GoalStatusChanged, {
          sessionID: input.sessionID,
          timestamp: now,
          status: input.status,
          expectedVersion: input.expectedVersion,
        })
        .pipe(
          Effect.catchDefect((defect) => {
            if (defect instanceof Conflict)
              return get(input.sessionID).pipe(
                Effect.flatMap(
                  (current) => new Conflict({ sessionID: input.sessionID, expectedVersion: current?.version ?? 0 }),
                ),
              )
            return Effect.die(defect)
          }),
        )
      return yield* result(input.sessionID)
    })

    const context: Interface["context"] = Effect.fn("SessionGoal.context")(function* (sessionID) {
      const goal = yield* get(sessionID)
      if (!goal) return SystemContext.empty
      return SystemContext.make({
        key: SystemContext.Key.make("core/session-goal"),
        codec: Schema.toCodecJson(Info),
        load: Effect.succeed(goal),
        baseline: render,
        update: (_previous, current) =>
          ["The session goal changed. This supersedes any previously rendered goal.", render(current)].join("\n"),
        removed: () => "The session goal was cleared. Do not act on any previously stated objective.",
      })
    })

    return Service.of({ get, update, setStatus, context })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [EventV2.node, Database.node] })
