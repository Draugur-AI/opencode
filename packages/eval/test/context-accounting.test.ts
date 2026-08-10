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
import { ContextAccounting } from "../src/context-accounting"
import { tmpdir } from "./lib/tmpdir"

describe("ContextAccounting.breakdown", () => {
  test("attributes goal text to the goal bucket and the prompt to the tail bucket", async () => {
    const handle = EvalGraph.build({ databasePath: `${tmpdir()}/eval.db`, directory: AbsolutePath.make("/project") })
    const sessionID = SessionV2.ID.make("ses_eval_accounting")

    await Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
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
          title: "eval-accounting",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.GoalUpdated, {
        sessionID,
        timestamp: yield* DateTime.now,
        objective: "Account for context sources",
        acceptanceCriteria: [],
        constraints: [],
        sourceMessageIDs: [],
      })

      const session = yield* SessionV2.Service
      handle.llm.push(FakeLLM.textTurn("On it."))
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "A distinctive prompt marker" }), resume: false })
      yield* session.resume(sessionID)

      const breakdown = ContextAccounting.breakdown(handle.llm.requests[0]!)
      expect(breakdown.goal.tokens).toBeGreaterThan(0)
      expect(breakdown.ledger.tokens).toBe(0)
      expect(breakdown.tail.tokens).toBeGreaterThan(0)
      expect(breakdown.total.tokens).toBe(
        breakdown.goal.tokens +
          breakdown.ledger.tokens +
          breakdown.otherSystem.tokens +
          breakdown.tail.tokens +
          breakdown.tools.tokens,
      )
    }).pipe(Effect.scoped, Effect.provide(handle.layer), Effect.runPromise)
  })
})
