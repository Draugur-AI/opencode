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
import { CompactionEpoch } from "../src/compaction-epoch"
import { FakeLLM } from "../src/fake-llm"
import { tmpdir } from "./lib/tmpdir"

describe("CompactionEpoch.inject", () => {
  test("a goal survives an injected compaction epoch even though the summary never mentions it", async () => {
    const handle = EvalGraph.build({ databasePath: `${tmpdir()}/eval.db`, directory: AbsolutePath.make("/project") })
    const sessionID = SessionV2.ID.make("ses_eval_epoch")

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
          title: "eval-epoch",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.GoalUpdated, {
        sessionID,
        timestamp: yield* DateTime.now,
        objective: "Recover the identifier",
        acceptanceCriteria: [],
        constraints: [],
        sourceMessageIDs: [],
      })

      const session = yield* SessionV2.Service
      handle.llm.push(FakeLLM.textTurn("First reply."))
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First message" }), resume: false })
      yield* session.resume(sessionID)

      yield* CompactionEpoch.inject({
        sessionID,
        summary: "User asked something unrelated to the objective.",
      })

      handle.llm.resetRequests()
      handle.llm.push(FakeLLM.textTurn("Second reply, after compaction."))
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second message" }), resume: false })
      yield* session.resume(sessionID)

      const system = handle.llm.requests[0]!.system.map((part) => part.text).join("\n")
      expect(system).toContain("Recover the identifier")
      expect(system).not.toContain("First message")
    }).pipe(Effect.scoped, Effect.provide(handle.layer), Effect.runPromise)
  })
})
