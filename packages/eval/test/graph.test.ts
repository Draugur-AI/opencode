import { describe, expect, test } from "bun:test"
import { DateTime, Effect } from "effect"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionGoal } from "@opencode-ai/core/session/goal"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { EvalGraph } from "../src/graph"
import { FakeLLM } from "../src/fake-llm"
import { tmpdir } from "./lib/tmpdir"

const setupSession = Effect.fn("test.setupSession")(function* (sessionID: SessionV2.ID) {
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
      title: "eval",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

describe("EvalGraph: real path smoke test", () => {
  test("a durable goal survives into the composed system prompt after a real turn", async () => {
    const handle = EvalGraph.build({ databasePath: `${tmpdir()}/eval.db`, directory: AbsolutePath.make("/project") })
    const sessionID = SessionV2.ID.make("ses_eval_smoke")

    await Effect.gen(function* () {
      yield* setupSession(sessionID)
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.GoalUpdated, {
        sessionID,
        timestamp: yield* DateTime.now,
        objective: "Ship the eval harness",
        acceptanceCriteria: [],
        constraints: [{ id: SessionGoal.ConstraintID.make("cons_smoke"), text: "Never call the destructive tool" }],
        sourceMessageIDs: [],
      })

      const session = yield* SessionV2.Service
      handle.llm.push(FakeLLM.textTurn("On it."))
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Go" }), resume: false })
      yield* session.resume(sessionID)

      expect(handle.llm.requests).toHaveLength(1)
      const system = handle.llm.requests[0]!.system.map((part) => part.text).join("\n")
      expect(system).toContain("Ship the eval harness")
      expect(system).toContain("Never call the destructive tool")
    }).pipe(Effect.scoped, Effect.provide(handle.layer), Effect.runPromise)
  })

  test("B-mode: the same goal does not appear in the composed system prompt", async () => {
    const handle = EvalGraph.build({
      databasePath: `${tmpdir()}/eval.db`,
      directory: AbsolutePath.make("/project"),
      overrides: EvalGraph.preSlice4Overrides,
    })
    const sessionID = SessionV2.ID.make("ses_eval_smoke_b")

    await Effect.gen(function* () {
      yield* setupSession(sessionID)
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.GoalUpdated, {
        sessionID,
        timestamp: yield* DateTime.now,
        objective: "Ship the eval harness",
        acceptanceCriteria: [],
        constraints: [],
        sourceMessageIDs: [],
      })

      const session = yield* SessionV2.Service
      handle.llm.push(FakeLLM.textTurn("On it."))
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Go" }), resume: false })
      yield* session.resume(sessionID)

      const system = handle.llm.requests[0]!.system.map((part) => part.text).join("\n")
      expect(system).not.toContain("Ship the eval harness")
    }).pipe(Effect.scoped, Effect.provide(handle.layer), Effect.runPromise)
  })
})
