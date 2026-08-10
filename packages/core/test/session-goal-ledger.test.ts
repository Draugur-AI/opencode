import { describe, expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionContextEpoch } from "@opencode-ai/core/session/context-epoch"
import { SessionGoal } from "@opencode-ai/core/session/goal"
import { SessionLedger } from "@opencode-ai/core/session/ledger"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SystemContext } from "@opencode-ai/core/system-context"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionGoal.node, SessionLedger.node])),
)

let seq = 0
const seed = () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const id = SessionV2.ID.make(`ses_goalledger_${seq++}`)
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({ id, project_id: Project.ID.global, slug: id, directory: "/project", title: id, version: "test" })
      .run()
      .pipe(Effect.orDie)
    return id
  })

describe("SessionGoal", () => {
  it.effect("update rejects a stale expectedVersion and reports the version that won", () =>
    Effect.gen(function* () {
      const goal = yield* SessionGoal.Service
      const sessionID = yield* seed()

      const created = yield* goal.update({
        sessionID,
        objective: "Fix the login bug",
        acceptanceCriteria: [],
        constraints: [],
        sourceMessageIDs: [],
      })
      expect(created.version).toBeGreaterThan(0)

      const stale = created.version - 1
      const exit = yield* goal
        .update({
          sessionID,
          objective: "A different objective entirely",
          acceptanceCriteria: [],
          constraints: [],
          sourceMessageIDs: [],
          expectedVersion: stale,
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.squash(exit.cause)
        expect(failure).toBeInstanceOf(SessionGoal.Conflict)
        if (failure instanceof SessionGoal.Conflict) expect(failure.expectedVersion).toBe(created.version)
      }

      // The row must be untouched by the losing write.
      const current = yield* goal.get(sessionID)
      expect(current?.objective).toBe("Fix the login bug")
      expect(current?.version).toBe(created.version)
    }),
  )

  it.effect("two concurrent updates against the same expectedVersion: exactly one wins", () =>
    Effect.gen(function* () {
      const goal = yield* SessionGoal.Service
      const sessionID = yield* seed()
      const created = yield* goal.update({
        sessionID,
        objective: "initial",
        acceptanceCriteria: [],
        constraints: [],
        sourceMessageIDs: [],
      })

      const attempt = (objective: string) =>
        goal
          .update({
            sessionID,
            objective,
            acceptanceCriteria: [],
            constraints: [],
            sourceMessageIDs: [],
            expectedVersion: created.version,
          })
          .pipe(Effect.exit)

      const [a, b] = yield* Effect.all([attempt("racer-a"), attempt("racer-b")], { concurrency: "unbounded" })
      const successes = [a, b].filter(Exit.isSuccess)
      const failures = [a, b].filter(Exit.isFailure)
      expect(successes.length).toBe(1)
      expect(failures.length).toBe(1)

      // The row reflects exactly the winner -- never a merge of both, never neither.
      const final = yield* goal.get(sessionID)
      expect(final?.objective).toBeDefined()
      expect(["racer-a", "racer-b"]).toContain(final!.objective)
    }),
  )

  it.effect("a goal committed durably is readable without the context epoch ever having run again -- the crash point between event commit and epoch observation cannot lose or corrupt it", () =>
    Effect.gen(function* () {
      const goal = yield* SessionGoal.Service
      const sessionID = yield* seed()

      yield* goal.update({
        sessionID,
        objective: "Ship the fix",
        acceptanceCriteria: [{ id: SessionGoal.CriterionID.make("c1"), text: "Tests pass", status: "open" }],
        constraints: [],
        sourceMessageIDs: [],
      })

      // Simulate "the process died right after the event committed": nothing about
      // SessionContextEpoch.initialize/prepare is called here at all. A fresh service handle
      // (a new goal.get()) must still see the fully-committed row -- the durable write does not
      // depend on any epoch-related step ever running afterward.
      const recovered = yield* goal.get(sessionID)
      expect(recovered?.objective).toBe("Ship the fix")
      expect(recovered?.acceptanceCriteria).toEqual([{ id: SessionGoal.CriterionID.make("c1"), text: "Tests pass", status: "open" }])
    }),
  )

  it.effect("outcome: after a mid-session update, the next context() render carries the new objective and not the superseded one", () =>
    Effect.gen(function* () {
      const goal = yield* SessionGoal.Service
      const sessionID = yield* seed()

      const before = yield* goal.context(sessionID).pipe(Effect.flatMap(SystemContext.initialize))
      expect(before.baseline).toBe("") // no goal set yet: contributes nothing

      const first = yield* goal.update({
        sessionID,
        objective: "Original objective",
        acceptanceCriteria: [],
        constraints: [],
        sourceMessageIDs: [],
      })
      const afterFirst = yield* goal.context(sessionID).pipe(Effect.flatMap(SystemContext.initialize))
      expect(afterFirst.baseline).toContain("Original objective")

      yield* goal.update({
        sessionID,
        objective: "Superseding objective",
        acceptanceCriteria: [],
        constraints: [],
        sourceMessageIDs: [],
        expectedVersion: first.version,
      })
      const afterSecond = yield* goal.context(sessionID).pipe(Effect.flatMap(SystemContext.initialize))
      expect(afterSecond.baseline).toContain("Superseding objective")
      expect(afterSecond.baseline).not.toContain("Original objective")
    }),
  )
})

describe("SessionLedger", () => {
  it.effect("add refuses at the byte cap without silently dropping, then succeeds after supersede frees room", () =>
    Effect.gen(function* () {
      const ledger = yield* SessionLedger.Service
      const sessionID = yield* seed()

      // Fill most of the byte budget with one entry, leaving no room for a second of this size.
      const big = "x".repeat(SessionLedger.MaxActiveBytes - 100)
      const first = yield* ledger.add({ sessionID, kind: "fact", text: big, sourceMessageIDs: [] })

      const exit = yield* ledger
        .add({ sessionID, kind: "fact", text: "y".repeat(200), sourceMessageIDs: [] })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(SessionLedger.CapExceededError)

      // Refused, not silently dropped: exactly the one entry exists, unchanged.
      const activeAfterRefusal = yield* ledger.list(sessionID, { status: "active" })
      expect(activeAfterRefusal).toHaveLength(1)
      expect(activeAfterRefusal[0]?.text).toBe(big)

      // Superseding frees the budget; the same add now succeeds.
      yield* ledger.supersede({ sessionID, entryID: first.id, supersededBy: first.id })
      const second = yield* ledger.add({ sessionID, kind: "fact", text: "y".repeat(200), sourceMessageIDs: [] })
      expect(second.text).toBe("y".repeat(200))
    }),
  )

  it.effect("outcome: after supersede, the next context() render excludes the superseded entry", () =>
    Effect.gen(function* () {
      const ledger = yield* SessionLedger.Service
      const sessionID = yield* seed()

      const first = yield* ledger.add({ sessionID, kind: "decision", text: "Use approach A", sourceMessageIDs: [] })
      const beforeSupersede = yield* ledger.context(sessionID).pipe(Effect.flatMap(SystemContext.initialize))
      expect(beforeSupersede.baseline).toContain("Use approach A")

      const second = yield* ledger.add({ sessionID, kind: "decision", text: "Use approach B instead", sourceMessageIDs: [] })
      yield* ledger.supersede({ sessionID, entryID: first.id, supersededBy: second.id })

      const afterSupersede = yield* ledger.context(sessionID).pipe(Effect.flatMap(SystemContext.initialize))
      expect(afterSupersede.baseline).toContain("Use approach B instead")
      expect(afterSupersede.baseline).not.toContain("Use approach A")
    }),
  )
})

describe("goal survives compaction (TKT-317 done-condition)", () => {
  it.effect("a compacted session's freshly-assembled context still carries the goal, even though the compaction summary never mentions it", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const goal = yield* SessionGoal.Service
      const ledger = yield* SessionLedger.Service
      const sessionID = yield* seed()

      yield* goal.update({
        sessionID,
        objective: "Migrate the billing service off the old queue",
        acceptanceCriteria: [{ id: SessionGoal.CriterionID.make("c1"), text: "Old queue fully drained", status: "open" }],
        constraints: [],
        sourceMessageIDs: [],
      })

      const loadContext = Effect.gen(function* () {
        return SystemContext.combine([yield* goal.context(sessionID), yield* ledger.context(sessionID)])
      })

      // Establish the pre-compaction baseline, same as the runner does at turn start.
      const initialized = yield* SessionContextEpoch.initialize(db, loadContext, sessionID)
      expect(initialized?.baseline).toContain("Migrate the billing service off the old queue")

      // Simulate a completed compaction: a session_message row of type "compaction", at a seq
      // past the stored baseline_seq, whose summary is deliberately about something else --
      // proving the goal in the rebuilt baseline came from durable state, not from the summary.
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: SessionMessage.ID.create(),
          session_id: sessionID,
          type: "compaction",
          seq: (initialized?.baselineSeq ?? 0) + 1,
          data: {
            reason: "auto",
            summary: "The user asked about deployment timing. No goal or objective was discussed.",
            recent: "",
          } as never,
        })
        .run()
        .pipe(Effect.orDie)

      const rebuilt = yield* SessionContextEpoch.prepare(db, events, loadContext, sessionID)

      expect(rebuilt.baseline).toContain("Migrate the billing service off the old queue")
      expect(rebuilt.baseline).toContain("Old queue fully drained")
      // The rebuild is a real replacement, not a no-op that happened to keep the old baseline.
      expect(rebuilt.baselineSeq).toBeGreaterThan(initialized?.baselineSeq ?? 0)
    }),
  )
})
