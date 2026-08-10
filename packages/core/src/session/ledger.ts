export * as SessionLedger from "./ledger"

import { and, desc, eq, sql } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { SessionLedger as LedgerSchema } from "@opencode-ai/schema/session-ledger"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { SystemContext } from "../system-context/index"
import { SessionSchema } from "./schema"
import { SessionEvent } from "./event"
import { SessionLedgerTable } from "./sql"
import type { SessionMessage } from "./message"

type DatabaseService = Database.Interface["db"]

export const ID = LedgerSchema.ID
export type ID = typeof ID.Type
export const Kind = LedgerSchema.Kind
export type Kind = typeof Kind.Type
export const Entry = LedgerSchema.Entry
export type Entry = typeof Entry.Type

/**
 * Hard budget for the ACTIVE ledger, never silently enforced by dropping the oldest entry: add()
 * refuses once either limit is hit and the caller must supersede an entry first. Byte limit
 * approximates the design post's "roughly 2,000 tokens" budget for the working ledger at ~4
 * bytes/token; entry count is capped separately so one long entry cannot exhaust the whole budget
 * while looking like "one entry" to a reader.
 */
export const MaxActiveEntries = 50
export const MaxActiveBytes = 8_000

type Row = typeof SessionLedgerTable.$inferSelect

const fromRow = (row: Row): Entry => ({
  id: row.id,
  sessionID: row.session_id,
  kind: row.kind,
  text: row.text,
  sourceMessageIDs: row.source_message_ids,
  status: row.status,
  supersededBy: row.superseded_by ?? undefined,
  time: { created: DateTime.makeUnsafe(row.time_created), updated: DateTime.makeUnsafe(row.time_updated) },
})

export class CapExceededError extends Schema.TaggedErrorClass<CapExceededError>()("SessionLedger.CapExceededError", {
  sessionID: SessionSchema.ID,
  activeCount: Schema.Int,
  activeBytes: Schema.Int,
}) {}

export class EntryNotFoundError extends Schema.TaggedErrorClass<EntryNotFoundError>()(
  "SessionLedger.EntryNotFoundError",
  { entryID: ID },
) {}

/** Apply one committed `LedgerAdded` event. Plain insert -- entry IDs are generated, not caller
 * supplied, so a collision would be a genuine anomaly rather than a concurrency case to CAS on. */
export const projectAdded = Effect.fn("SessionLedger.projectAdded")(function* (
  db: DatabaseService,
  input: {
    readonly entryID: ID
    readonly sessionID: SessionSchema.ID
    readonly kind: Kind
    readonly text: string
    readonly sourceMessageIDs: ReadonlyArray<SessionMessage.ID>
    readonly timestamp: DateTime.Utc
  },
) {
  const now = DateTime.toEpochMillis(input.timestamp)
  yield* db
    .insert(SessionLedgerTable)
    .values({
      id: input.entryID,
      session_id: input.sessionID,
      kind: input.kind,
      text: input.text,
      source_message_ids: [...input.sourceMessageIDs],
      status: "active",
      time_created: now,
      time_updated: now,
    })
    .run()
    .pipe(Effect.orDie)
})

/** Apply one committed `LedgerSuperseded` event. CAS on status='active' AND session_id=sessionID,
 * so a double-supersession loses the race rather than overwriting supersededBy, and an entry
 * cannot be superseded from the wrong session's event stream. */
export const projectSuperseded = Effect.fn("SessionLedger.projectSuperseded")(function* (
  db: DatabaseService,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly entryID: ID
    readonly supersededBy: ID
    readonly timestamp: DateTime.Utc
  },
) {
  const now = DateTime.toEpochMillis(input.timestamp)
  const updated = yield* db
    .update(SessionLedgerTable)
    .set({ status: "superseded", superseded_by: input.supersededBy, time_updated: now })
    .where(
      and(
        eq(SessionLedgerTable.id, input.entryID),
        eq(SessionLedgerTable.session_id, input.sessionID),
        eq(SessionLedgerTable.status, "active"),
      ),
    )
    .returning({ id: SessionLedgerTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!updated) return yield* Effect.die(new EntryNotFoundError({ entryID: input.entryID }))
})

export interface Interface {
  readonly list: (
    sessionID: SessionSchema.ID,
    options?: { readonly status?: "active" | "superseded" | "all" },
  ) => Effect.Effect<ReadonlyArray<Entry>>
  readonly add: (input: {
    readonly sessionID: SessionSchema.ID
    readonly kind: Kind
    readonly text: string
    readonly sourceMessageIDs: ReadonlyArray<SessionMessage.ID>
  }) => Effect.Effect<Entry, CapExceededError>
  readonly supersede: (input: {
    readonly sessionID: SessionSchema.ID
    readonly entryID: ID
    readonly supersededBy: ID
  }) => Effect.Effect<void, EntryNotFoundError>
  /** A session-scoped SystemContext source: active entries only, newest first, rendered every
   * turn from durable state. Not registered into the location-wide SystemContextRegistry -- called
   * directly by the runner with the active sessionID. */
  readonly context: (sessionID: SessionSchema.ID) => Effect.Effect<SystemContext.SystemContext>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionLedger") {}

const render = (entries: ReadonlyArray<Entry>) =>
  [
    "<session_ledger>",
    ...(entries.length === 0
      ? ["  (empty -- nothing recorded yet)"]
      : entries.map((e) => `  <entry id="${e.id}" kind="${e.kind}">${e.text}</entry>`)),
    "</session_ledger>",
    "The ledger above lists facts that must remain true while continuing this task -- decisions",
    "made, constraints discovered, findings, risks, and next steps. Superseded entries are",
    "already excluded; do not act on a fact contradicted by a newer entry.",
  ].join("\n")

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service

    const list: Interface["list"] = Effect.fn("SessionLedger.list")(function* (sessionID, options) {
      const status = options?.status ?? "active"
      const rows = yield* db
        .select()
        .from(SessionLedgerTable)
        .where(
          and(
            eq(SessionLedgerTable.session_id, sessionID),
            ...(status === "all" ? [] : [eq(SessionLedgerTable.status, status)]),
          ),
        )
        .orderBy(desc(SessionLedgerTable.time_created))
        .all()
        .pipe(Effect.orDie)
      return rows.map(fromRow)
    })

    const activeUsage = Effect.fn("SessionLedger.activeUsage")(function* (sessionID: SessionSchema.ID) {
      const row = yield* db
        .select({
          count: sql<number>`count(*)`,
          bytes: sql<number>`coalesce(sum(length(${SessionLedgerTable.text})), 0)`,
        })
        .from(SessionLedgerTable)
        .where(and(eq(SessionLedgerTable.session_id, sessionID), eq(SessionLedgerTable.status, "active")))
        .get()
        .pipe(Effect.orDie)
      return { count: row?.count ?? 0, bytes: row?.bytes ?? 0 }
    })

    const add: Interface["add"] = Effect.fn("SessionLedger.add")(function* (input) {
      const usage = yield* activeUsage(input.sessionID)
      const nextBytes = usage.bytes + Buffer.byteLength(input.text, "utf8")
      if (usage.count + 1 > MaxActiveEntries || nextBytes > MaxActiveBytes)
        return yield* new CapExceededError({
          sessionID: input.sessionID,
          activeCount: usage.count,
          activeBytes: usage.bytes,
        })

      const entryID = ID.create()
      const now = yield* DateTime.now
      yield* events.publish(SessionEvent.LedgerAdded, {
        sessionID: input.sessionID,
        timestamp: now,
        entryID,
        kind: input.kind,
        text: input.text,
        sourceMessageIDs: input.sourceMessageIDs,
      })
      const row = yield* db.select().from(SessionLedgerTable).where(eq(SessionLedgerTable.id, entryID)).get().pipe(Effect.orDie)
      if (!row) return yield* Effect.die(`Ledger projection missing for ${entryID} immediately after commit`)
      return fromRow(row)
    })

    const supersede: Interface["supersede"] = Effect.fn("SessionLedger.supersede")(function* (input) {
      const now = yield* DateTime.now
      yield* events
        .publish(SessionEvent.LedgerSuperseded, {
          sessionID: input.sessionID,
          timestamp: now,
          entryID: input.entryID,
          supersededBy: input.supersededBy,
        })
        .pipe(
          Effect.catchDefect((defect) => {
            if (defect instanceof EntryNotFoundError) return Effect.fail(defect)
            return Effect.die(defect)
          }),
        )
    })

    const context: Interface["context"] = Effect.fn("SessionLedger.context")(function* (sessionID) {
      const entries = yield* list(sessionID, { status: "active" })
      // No entries yet is the common case (most turns, most sessions) -- contribute nothing rather
      // than a permanent "(empty)" placeholder in every system prompt. Matches SessionGoal.context
      // and SkillGuidance.load's own empty-case precedent.
      if (entries.length === 0) return SystemContext.empty
      return SystemContext.make({
        key: SystemContext.Key.make("core/session-ledger"),
        codec: Schema.toCodecJson(Schema.Array(Entry)),
        load: Effect.succeed(entries),
        baseline: render,
        update: (_previous, current) =>
          ["The working ledger changed. This supersedes any previously rendered ledger.", render(current)].join("\n"),
        removed: () => "The working ledger is no longer available.",
      })
    })

    return Service.of({ list, add, supersede, context })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [EventV2.node, Database.node] })
