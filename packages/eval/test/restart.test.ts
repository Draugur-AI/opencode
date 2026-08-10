import { describe, expect, test } from "bun:test"
import { DateTime, Effect } from "effect"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { EvalGraph } from "../src/graph"
import { FakeLLM } from "../src/fake-llm"
import { tmpdir } from "./lib/tmpdir"

/**
 * "Across process restarts" from the spec, simulated the way the researched codebase already
 * proves DB-reopen safety (Database.layerFromPath against the same file, see
 * database-migration.test.ts / session-create.test.ts): build a fresh AppNodeBuilder graph
 * pointed at the same database path, in a scope disjoint from the first. Nothing about the
 * runner, goal, or ledger services carries over except what is durable in that file.
 */
describe("EvalGraph: restart survival", () => {
  test("a durable goal survives a fresh graph rebuilt against the same database file", async () => {
    const databasePath = `${tmpdir()}/eval.db`
    const directory = AbsolutePath.make("/project")
    const sessionID = SessionV2.ID.make("ses_eval_restart")

    const before = EvalGraph.build({ databasePath, directory })
    await Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: sessionID,
          directory: "/project",
          title: "eval-restart",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.GoalUpdated, {
        sessionID,
        timestamp: yield* DateTime.now,
        objective: "Survive a restart",
        acceptanceCriteria: [],
        constraints: [],
        sourceMessageIDs: [],
      })
    }).pipe(Effect.scoped, Effect.provide(before.layer), Effect.runPromise)

    // A disjoint graph, same file -- nothing from `before` (its FakeLLM instance, its in-memory
    // service state) is reachable from here except what SessionProjector actually persisted.
    const after = EvalGraph.build({ databasePath, directory })
    await Effect.gen(function* () {
      const session = yield* SessionV2.Service
      after.llm.push(FakeLLM.textTurn("Still here."))
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Are you still tracking the goal?" }), resume: false })
      yield* session.resume(sessionID)

      const system = after.llm.requests[0]!.system.map((part) => part.text).join("\n")
      expect(system).toContain("Survive a restart")
    }).pipe(Effect.scoped, Effect.provide(after.layer), Effect.runPromise)
  })
})
