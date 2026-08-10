export * as SessionV2 from "./session"
export * from "./session/schema"

import { DateTime, Effect, Layer, Schema, Context, Stream } from "effect"
import { ListAnchor } from "@opencode-ai/schema/session"
import { and, asc, desc, eq, gt, like, lt, or, type SQL } from "drizzle-orm"
import { ProjectV2 } from "./project"
import { WorkspaceV2 } from "./workspace"
import { ModelV2 } from "./model"
import { Location } from "./location"
import { SessionMessage } from "./session/message"
import { Prompt } from "./session/prompt"
import { PromptInput } from "@opencode-ai/schema/prompt-input"
import { EventV2 } from "./event"
import { Database } from "./database/database"
import { SessionProjector } from "./session/projector"
import { SessionMessageTable, SessionTable } from "./session/sql"
import { SessionSchema } from "./session/schema"
import { SessionLifecycle } from "./session/lifecycle"
import { SessionPurge } from "./session/purge"
import { AbsolutePath, NonNegativeInt, PositiveInt, RelativePath } from "./schema"
import { AgentV2 } from "./agent"
import { SessionV1 } from "./v1/session"
import { InstallationVersion } from "./installation/version"
import { Slug } from "./util/slug"
import { ProjectTable } from "./project/sql"
import path from "path"
import { fromRow } from "./session/info"
import { SessionRunner } from "./session/runner/index"
import { SessionStore } from "./session/store"
import { SessionExecution } from "./session/execution"
import { makeGlobalNode } from "./effect/app-node"
import { LocationServiceMap } from "./location-service-map"
import { MessageDecodeError } from "./session/error"
import { SessionEvent } from "./session/event"
import { SessionInput } from "./session/input"
import { Snapshot } from "./snapshot"
import { SessionRevert } from "./session/revert"
import { Revert } from "@opencode-ai/schema/revert"
import { FSUtil } from "./fs-util"
import { SessionDurable } from "@opencode-ai/schema/durable-event-manifest"

export const RevertState = Revert.State
export type RevertState = Revert.State

// get project -> project.locations
//
// get all sessions
//

// - by project
//   - by subpath
// - by workspace (home is special)

export { ListAnchor }

const ListInputBase = {
  workspaceID: WorkspaceV2.ID.pipe(Schema.optional),
  search: Schema.String.pipe(Schema.optional),
  limit: PositiveInt.pipe(Schema.optional),
  order: Schema.Literals(["asc", "desc"]).pipe(Schema.optional),
  anchor: ListAnchor.pipe(Schema.optional),
  /** Which lifecycle view to list. Defaults to `active`, so archived and trashed sessions are
   * absent from an unqualified list rather than mixed into it. */
  lifecycle: SessionLifecycle.Filter.pipe(Schema.optional),
}

const ListDirectoryInput = Schema.Struct({
  ...ListInputBase,
  directory: AbsolutePath,
})

const ListProjectInput = Schema.Struct({
  ...ListInputBase,
  project: ProjectV2.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

const ListAllInput = Schema.Struct(ListInputBase)

export const ListInput = Schema.Union([ListDirectoryInput, ListProjectInput, ListAllInput])
export type ListInput = typeof ListInput.Type

type CreateInput = {
  id?: SessionSchema.ID
  agent?: AgentV2.ID
  model?: ModelV2.Ref
  location: Location.Ref
}

type CompactInput = {
  sessionID: SessionSchema.ID
  prompt?: Prompt
}

type LifecycleInput = {
  sessionID: SessionSchema.ID
  /** Idempotency key. Repeating it after a dropped response resolves to the first outcome. */
  requestID: SessionLifecycle.RequestID
  /** The revision the caller believes it is mutating. Omitted means "whatever it is now". */
  expectedLifecycleRevision?: number
}

/** The lifecycle columns of one session row, which `SessionSchema.Info` does not all expose. */
type LifecycleRow = {
  readonly lifecycle: SessionLifecycle.State
  readonly lifecycle_revision: number
  readonly time_archived: number | null
  readonly time_updated: number
  readonly time_trashed: number | null
  readonly purge_after: number | null
  readonly trash_restore_to: SessionLifecycle.RestorableState | null
}

type PurgeInput = {
  sessionID: SessionSchema.ID
  requestID: SessionLifecycle.RequestID
  /** The session ID, echoed. Permanent deletion should not be reachable by a stray boolean. */
  confirmation: SessionSchema.ID
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Session.NotFoundError", {
  sessionID: SessionSchema.ID,
}) {}

export class OperationUnavailableError extends Schema.TaggedErrorClass<OperationUnavailableError>()(
  "Session.OperationUnavailableError",
  {
    operation: Schema.Literals(["move", "shell", "skill", "switchAgent", "compact", "wait"]),
  },
) {}

/** The row moved under the caller: a stale `expectedLifecycleRevision`, or a concurrent writer. */
export class LifecycleConflictError extends Schema.TaggedErrorClass<LifecycleConflictError>()(
  "Session.LifecycleConflictError",
  {
    sessionID: SessionSchema.ID,
    /** The revision the row actually holds, so a caller can retry without a second read. */
    lifecycleRevision: NonNegativeInt,
  },
) {}

/** The requested transition is not one the lifecycle allows from the state the session is in. */
export class LifecycleTransitionError extends Schema.TaggedErrorClass<LifecycleTransitionError>()(
  "Session.LifecycleTransitionError",
  {
    sessionID: SessionSchema.ID,
    from: SessionLifecycle.State,
    to: SessionLifecycle.State,
  },
) {}

/** Permanent deletion was requested without echoing the session ID back. */
export class ConfirmationRequiredError extends Schema.TaggedErrorClass<ConfirmationRequiredError>()(
  "Session.ConfirmationRequiredError",
  { sessionID: SessionSchema.ID },
) {}

export type LifecycleError = NotFoundError | LifecycleConflictError | LifecycleTransitionError

export { ContextSnapshotDecodeError, MessageDecodeError } from "./session/error"

export class PromptConflictError extends Schema.TaggedErrorClass<PromptConflictError>()("Session.PromptConflictError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
}) {}
export const MessageNotFoundError = SessionRevert.MessageNotFoundError
export type MessageNotFoundError = SessionRevert.MessageNotFoundError

export type Error = NotFoundError | MessageDecodeError | OperationUnavailableError | PromptConflictError

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<SessionSchema.Info[]>
  readonly create: (input: CreateInput) => Effect.Effect<SessionSchema.Info>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info, NotFoundError>
  /** Hide a completed session from active views. Reversible with `restore`. */
  readonly archive: (input: LifecycleInput) => Effect.Effect<SessionSchema.Info, LifecycleError>
  /** Return an archived session to active views. */
  readonly restore: (input: LifecycleInput) => Effect.Effect<SessionSchema.Info, LifecycleError>
  /** Mark a session for deletion after a grace period. Reversible with `restoreFromTrash`. */
  readonly trash: (input: LifecycleInput) => Effect.Effect<SessionSchema.Info, LifecycleError>
  /** Take a session back out of trash, to whichever state it was in when it went in. */
  readonly restoreFromTrash: (input: LifecycleInput) => Effect.Effect<SessionSchema.Info, LifecycleError>
  /**
   * Permanently delete a trashed session and everything it owns. Not reversible. Idempotent: a
   * retry against an already-purged session returns the same tombstone rather than failing.
   */
  readonly purge: (
    input: PurgeInput,
  ) => Effect.Effect<SessionLifecycle.Tombstone, NotFoundError | LifecycleTransitionError | ConfirmationRequiredError>
  /** What a purged session left behind, while it is still within its retention window. */
  readonly tombstone: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<SessionLifecycle.Tombstone | undefined>
  readonly messages: (input: {
    sessionID: SessionSchema.ID
    limit?: number
    order?: "asc" | "desc"
    cursor?: {
      id: SessionMessage.ID
      direction: "previous" | "next"
    }
  }) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError>
  readonly message: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
  }) => Effect.Effect<SessionMessage.Message | undefined>
  readonly context: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError>
  readonly events: (input: {
    sessionID: SessionSchema.ID
    after?: number
  }) => Stream.Stream<SessionEvent.DurableEvent, NotFoundError>
  readonly history: (input: {
    sessionID: SessionSchema.ID
    after?: number
    limit: number
  }) => Effect.Effect<{ events: ReadonlyArray<SessionEvent.DurableEvent>; hasMore: boolean }, NotFoundError>
  readonly switchAgent: (input: { sessionID: SessionSchema.ID; agent: string }) => Effect.Effect<void, NotFoundError>
  readonly switchModel: (input: {
    sessionID: SessionSchema.ID
    model: ModelV2.Ref
  }) => Effect.Effect<void, NotFoundError>
  readonly prompt: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    prompt: PromptInput.Prompt
    delivery?: SessionInput.Delivery
    resume?: boolean
  }) => Effect.Effect<SessionInput.Admitted, NotFoundError | PromptConflictError>
  readonly shell: (input: {
    id?: EventV2.ID
    sessionID: SessionSchema.ID
    command: string
    resume?: boolean
  }) => Effect.Effect<void, OperationUnavailableError>
  readonly skill: (input: {
    id?: EventV2.ID
    sessionID: SessionSchema.ID
    skill: string
    resume?: boolean
  }) => Effect.Effect<void, OperationUnavailableError>
  readonly compact: (input: CompactInput) => Effect.Effect<void, NotFoundError | OperationUnavailableError>
  readonly wait: (id: SessionSchema.ID) => Effect.Effect<void, NotFoundError | OperationUnavailableError>
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | SessionRunner.RunError>
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly revert: {
    readonly stage: (input: {
      sessionID: SessionSchema.ID
      messageID: SessionMessage.ID
      files?: boolean
    }) => Effect.Effect<Revert.State, NotFoundError | MessageNotFoundError | Snapshot.Error>
    readonly clear: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | Snapshot.Error>
    readonly commit: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Session") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const events = yield* EventV2.Service
    const projects = yield* ProjectV2.Service
    const execution = yield* SessionExecution.Service
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const fs = yield* FSUtil.Service
    const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)
    const isDurableSessionEvent = Schema.is(SessionEvent.Durable)
    const decode = (row: typeof SessionMessageTable.$inferSelect) =>
      decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(
        Effect.mapError(
          () =>
            new MessageDecodeError({
              sessionID: SessionSchema.ID.make(row.session_id),
              messageID: SessionMessage.ID.make(row.id),
            }),
        ),
      )

    /** The lifecycle columns, which `SessionSchema.Info` deliberately does not all expose. */
    const lifecycleRow = Effect.fn("V2Session.lifecycleRow")(function* (sessionID: SessionSchema.ID) {
      return yield* db
        .select({
          lifecycle: SessionTable.lifecycle,
          lifecycle_revision: SessionTable.lifecycle_revision,
          time_archived: SessionTable.time_archived,
          time_updated: SessionTable.time_updated,
          time_trashed: SessionTable.time_trashed,
          purge_after: SessionTable.purge_after,
          trash_restore_to: SessionTable.trash_restore_to,
        })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
    })


    /**
     * One path for every lifecycle verb, so the checks cannot drift apart between them.
     *
     * The revision read here is always passed on as the event's `expectedLifecycleRevision`, even
     * when the caller supplied none. The check that decides the outcome is the compare-and-set
     * inside the commit transaction; checking here only lets us answer with a typed error instead
     * of a rolled-back transaction in the common case.
     */
    const mutateLifecycle = Effect.fn("V2Session.mutateLifecycle")(function* (
      input: LifecycleInput,
      next: (row: LifecycleRow, now: DateTime.Utc) => SessionLifecycle.Value,
    ) {
      const row = yield* lifecycleRow(input.sessionID)
      if (!row) return yield* new NotFoundError({ sessionID: input.sessionID })

      const applied = yield* SessionLifecycle.findRequest(db, input.sessionID, input.requestID)
      if (applied !== undefined) return yield* result.get(input.sessionID)

      if (
        input.expectedLifecycleRevision !== undefined &&
        row.lifecycle_revision !== input.expectedLifecycleRevision
      )
        return yield* new LifecycleConflictError({
          sessionID: input.sessionID,
          lifecycleRevision: row.lifecycle_revision,
        })

      const now = yield* DateTime.now
      const from = SessionLifecycle.fromRow(row)
      const to = next(row, now)
      if (!SessionLifecycle.canTransition(from.state, to.state))
        return yield* new LifecycleTransitionError({
          sessionID: input.sessionID,
          from: from.state,
          to: to.state,
        })

      yield* events
        .publish(SessionEvent.LifecycleChanged, {
          sessionID: input.sessionID,
          timestamp: now,
          from,
          to,
          requestID: input.requestID,
          expectedLifecycleRevision: input.expectedLifecycleRevision ?? row.lifecycle_revision,
        })
        .pipe(
          Effect.catchDefect((defect) => {
            // Lost the in-transaction compare-and-set: report the revision that won.
            if (defect instanceof SessionLifecycle.Conflict)
              return lifecycleRow(input.sessionID).pipe(
                Effect.flatMap(
                  (current) =>
                    new LifecycleConflictError({
                      sessionID: input.sessionID,
                      lifecycleRevision: current?.lifecycle_revision ?? 0,
                    }),
                ),
              )
            // A concurrent delivery of the same request ID committed first. That is the outcome
            // this request asked for, so read it back rather than reporting a failure.
            if (defect instanceof SessionLifecycle.DuplicateRequest) return Effect.void
            return Effect.die(defect)
          }),
        )

      return yield* result.get(input.sessionID)
    })

    const result = Service.of({
      create: Effect.fn("V2Session.create")(function* (input) {
        const sessionID = input.id ?? SessionSchema.ID.create()
        const recorded = yield* store.get(sessionID)
        if (recorded) return recorded
        const project = yield* projects.resolve(input.location.directory)
        yield* db
          .insert(ProjectTable)
          .values({ id: project.id, worktree: project.directory, vcs: project.vcs?.type, sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        const now = Date.now()
        const info = SessionV1.SessionInfo.make({
          id: sessionID,
          slug: Slug.create(),
          version: InstallationVersion,
          projectID: project.id,
          directory: input.location.directory,
          path: path.relative(project.directory, input.location.directory).replaceAll("\\", "/"),
          workspaceID: input.location.workspaceID ? WorkspaceV2.ID.make(input.location.workspaceID) : undefined,
          title: `New session - ${new Date(now).toISOString()}`,
          agent: input.agent,
          model: input.model
            ? {
                id: ModelV2.ID.make(input.model.id),
                providerID: input.model.providerID,
                variant: input.model.variant,
              }
            : undefined,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        })
        const projected = yield* events
          .publish(SessionV1.Event.Created, { sessionID, info }, { location: input.location })
          .pipe(
            Effect.as({ type: "created" } as const),
            Effect.catchDefect((defect) => {
              if (!(defect instanceof SessionProjector.SessionAlreadyProjected)) {
                return Effect.die(defect)
              }
              // Concurrent creation lost the projection race. The existing Session identity wins.
              return store
                .get(sessionID)
                .pipe(
                  Effect.flatMap((session) =>
                    session ? Effect.succeed({ type: "existing", session } as const) : Effect.die(defect),
                  ),
                )
            }),
          )
        if (projected.type === "existing") return projected.session
        // TODO: Restore recorded sessions onto replacement synchronized workspaces in a future API slice.
        return yield* result.get(sessionID).pipe(Effect.orDie)
      }),
      get: Effect.fn("V2Session.get")(function* (sessionID) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* new NotFoundError({ sessionID })
        return session
      }),
      archive: (input) => mutateLifecycle(input, (_row, now) => ({ state: "archived", at: now })),
      restore: (input) => mutateLifecycle(input, () => ({ state: "active" })),
      trash: (input) =>
        mutateLifecycle(input, (_row, now) => ({
          state: "trash",
          at: now,
          purgeAfter: DateTime.makeUnsafe(DateTime.toEpochMillis(now) + SessionLifecycle.TrashGraceMillis),
        })),
      restoreFromTrash: (input) =>
        mutateLifecycle(input, (row, now) => {
          // Only a trashed session can be restored from trash. Returning the state it is already
          // in makes the transition check reject the request, because no state is a legal target
          // for itself. Without this an archived session would be silently un-archived, since the
          // restore target defaults to `active` when there is no recorded trash origin.
          if (row.lifecycle !== "trash") return SessionLifecycle.fromRow(row)
          // `at` is the restore moment, not the original archive moment: leaving trash
          // re-establishes the archive rather than pretending the session never left it.
          return row.trash_restore_to === "archived" ? { state: "archived", at: now } : { state: "active" }
        }),
      purge: Effect.fn("V2Session.purge")(function* (input) {
        if (input.confirmation !== input.sessionID)
          return yield* new ConfirmationRequiredError({ sessionID: input.sessionID })
        const row = yield* lifecycleRow(input.sessionID)
        if (!row) {
          // Already gone. A retry of an acknowledged purge, or of one whose response was dropped,
          // resolves to the tombstone instead of a spurious not-found.
          const existing = yield* SessionPurge.tombstone(db, input.sessionID)
          if (existing) return existing
          return yield* new NotFoundError({ sessionID: input.sessionID })
        }
        if (row.lifecycle !== "trash")
          return yield* new LifecycleTransitionError({
            sessionID: input.sessionID,
            from: row.lifecycle,
            to: "trash",
          })
        // Stop the session running before its rows disappear underneath the runner.
        yield* execution.interrupt(input.sessionID)
        // A session-owned Monitor would be cancelled here. No monitor domain exists at this
        // commit; TKT-322 introduces one and owns adding that call plus its purge-policy test.
        const claimed = yield* SessionPurge.claim(db, {
          sessionID: input.sessionID,
          now: Date.now(),
          requireExpired: false,
        })
        if (!claimed) {
          const existing = yield* SessionPurge.tombstone(db, input.sessionID)
          if (existing) return existing
          return yield* new NotFoundError({ sessionID: input.sessionID })
        }
        yield* SessionPurge.removeObjects(fs, claimed.objects)
        return claimed.tombstone
      }),
      tombstone: (sessionID) => SessionPurge.tombstone(db, sessionID),
      list: Effect.fn("V2Session.list")(function* (input = {}) {
        const direction = input.anchor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const sortColumn = SessionTable.time_created
        const conditions: SQL[] = []
        if ("directory" in input) conditions.push(eq(SessionTable.directory, input.directory))
        if (input.workspaceID) conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
        if ("project" in input) conditions.push(eq(SessionTable.project_id, input.project))
        if (input.search) conditions.push(like(SessionTable.title, `%${input.search}%`))
        const lifecycle = input.lifecycle ?? "active"
        if (lifecycle !== "all") conditions.push(eq(SessionTable.lifecycle, lifecycle))
        if (input.anchor) {
          conditions.push(
            order === "asc"
              ? or(
                  gt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), gt(SessionTable.id, input.anchor.id)),
                )!
              : or(
                  lt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), lt(SessionTable.id, input.anchor.id)),
                )!,
          )
        }
        const query = db
          .select()
          .from(SessionTable)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(
            order === "asc" ? asc(sortColumn) : desc(sortColumn),
            order === "asc" ? asc(SessionTable.id) : desc(SessionTable.id),
          )
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return (direction === "previous" ? rows.toReversed() : rows).map((row) => fromRow(row))
      }),
      messages: Effect.fn("V2Session.messages")(function* (input) {
        yield* result.get(input.sessionID)
        const direction = input.cursor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const anchor = input.cursor
          ? yield* db
              .select({ seq: SessionMessageTable.seq })
              .from(SessionMessageTable)
              .where(
                and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.cursor.id)),
              )
              .get()
              .pipe(Effect.orDie)
          : undefined
        if (input.cursor && !anchor) return []
        const boundary = anchor
          ? order === "asc"
            ? gt(SessionMessageTable.seq, anchor.seq)
            : lt(SessionMessageTable.seq, anchor.seq)
          : undefined
        const where = boundary
          ? and(eq(SessionMessageTable.session_id, input.sessionID), boundary)
          : eq(SessionMessageTable.session_id, input.sessionID)
        const query = db
          .select()
          .from(SessionMessageTable)
          .where(where)
          .orderBy(order === "asc" ? asc(SessionMessageTable.seq) : desc(SessionMessageTable.seq))
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return yield* Effect.forEach(direction === "previous" ? rows.toReversed() : rows, decode)
      }),
      message: Effect.fn("V2Session.message")(function* (input) {
        const stored = yield* store.message(input.messageID)
        return stored?.sessionID === input.sessionID ? stored.message : undefined
      }),
      context: Effect.fn("V2Session.context")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* store.context(sessionID)
      }),
      events: (input) =>
        Stream.unwrap(
          result
            .get(input.sessionID)
            .pipe(Effect.as(events.durable({ aggregateID: input.sessionID, after: input.after }))),
        ).pipe(Stream.filter((event): event is SessionEvent.DurableEvent => isDurableSessionEvent(event))),
      history: Effect.fn("V2Session.history")(function* (input) {
        yield* result.get(input.sessionID)
        return yield* EventV2.readAggregate(db, {
          ...input,
          aggregateID: input.sessionID,
          manifest: SessionDurable,
        })
      }),
      prompt: Effect.fn("V2Session.prompt")((input) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            yield* result.get(input.sessionID)
            const prompt = resolvePrompt(input.prompt)
            const messageID = input.id ?? SessionMessage.ID.create()
            const delivery = input.delivery ?? "steer"
            const expected = { sessionID: input.sessionID, messageID, prompt, delivery }
            const admitted = yield* SessionInput.admit(db, events, {
              id: messageID,
              sessionID: input.sessionID,
              prompt,
              delivery,
            }).pipe(
              Effect.catchDefect((defect) =>
                defect instanceof SessionInput.LifecycleConflict
                  ? new PromptConflictError({ sessionID: input.sessionID, messageID })
                  : Effect.die(defect),
              ),
            )
            if (!SessionInput.equivalent(admitted, expected))
              return yield* new PromptConflictError({ sessionID: input.sessionID, messageID })
            if (input.resume !== false) yield* execution.wake(admitted.sessionID)
            return admitted
          }),
        ),
      ),
      shell: Effect.fn("V2Session.shell")(function* () {
        return yield* new OperationUnavailableError({ operation: "shell" })
      }),
      skill: Effect.fn("V2Session.skill")(function* () {
        return yield* new OperationUnavailableError({ operation: "skill" })
      }),
      switchAgent: Effect.fn("V2Session.switchAgent")(function* (input) {
        yield* result.get(input.sessionID)
        yield* events.publish(SessionEvent.AgentSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          agent: input.agent,
        })
      }),
      switchModel: Effect.fn("V2Session.switchModel")(function* (input) {
        const session = yield* result.get(input.sessionID)
        if (
          session.model?.providerID === input.model.providerID &&
          session.model.id === input.model.id &&
          (session.model.variant ?? "default") === (input.model.variant ?? "default")
        )
          return
        yield* events.publish(SessionEvent.ModelSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          model: input.model,
        })
      }),
      compact: Effect.fn("V2Session.compact")(function* (input) {
        yield* result.get(input.sessionID)
        return yield* new OperationUnavailableError({ operation: "compact" })
      }),
      wait: Effect.fn("V2Session.wait")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* new OperationUnavailableError({ operation: "wait" })
      }),
      active: execution.active,
      resume: Effect.fn("V2Session.resume")(function* (sessionID) {
        yield* result.get(sessionID)
        yield* execution.resume(sessionID)
      }),
      interrupt: Effect.fn("V2Session.interrupt")((sessionID) =>
        Effect.uninterruptible(execution.interrupt(sessionID)),
      ),
      revert: {
        stage: Effect.fn("V2Session.revert.stage")(function* (input) {
          const session = yield* result.get(input.sessionID)
          return yield* SessionRevert.stage({ session, messageID: input.messageID, files: input.files }).pipe(
            Effect.provideService(Database.Service, database),
            Effect.provideService(EventV2.Service, events),
            Effect.provide(locations.get(session.location)),
          )
        }),
        clear: Effect.fn("V2Session.revert.clear")(function* (sessionID) {
          const session = yield* result.get(sessionID)
          yield* SessionRevert.clear(session).pipe(
            Effect.provideService(EventV2.Service, events),
            Effect.provide(locations.get(session.location)),
          )
        }),
        commit: Effect.fn("V2Session.revert.commit")(function* (sessionID) {
          const session = yield* result.get(sessionID)
          yield* SessionRevert.commit(session).pipe(Effect.provideService(EventV2.Service, events))
        }),
      },
    })

    return result
  }),
)

const resolvePrompt = (input: PromptInput.Prompt) =>
  Prompt.make({
    text: input.text,
    agents: input.agents,
    files: input.files?.map((file) => {
      const dataMime = file.uri.match(/^data:([^;,]+)[;,]/i)?.[1]
      const target = URL.canParse(file.uri) ? new URL(file.uri).pathname : (file.name ?? file.uri)
      return {
        ...file,
        mime: dataMime ?? (target.endsWith("/") ? "application/x-directory" : FSUtil.mimeType(target)),
      }
    }),
  })

export const node = makeGlobalNode({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [
    Database.node,
    EventV2.node,
    ProjectV2.node,
    SessionExecution.node,
    SessionStore.node,
    LocationServiceMap.node,
    SessionProjector.node,
    FSUtil.node,
  ],
})
