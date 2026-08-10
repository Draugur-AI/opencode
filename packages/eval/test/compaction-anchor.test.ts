import { describe, expect, test } from "bun:test"
import { DateTime, Effect } from "effect"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
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

/**
 * The anchor fixture Ethan's TKT-319 ruling requires: at least one fixture must run the REAL
 * compaction pipeline end to end (real size-triggered call into SessionCompaction, a real
 * summarizer stream through the substituted LLM client, a real SessionContextEpoch replacement)
 * rather than the faster event-injection shortcut every other fixture uses. This is what
 * validates that the injection-driven fixtures' "deterministic-approximation" label is honest --
 * if this test and an injection-driven equivalent disagreed, the injection shortcut would be
 * hiding something real.
 */
describe("EvalGraph: real-compaction-path anchor", () => {
  test("a goal survives a size-triggered compaction the runner drives itself", async () => {
    const handle = EvalGraph.build({
      databasePath: `${tmpdir()}/eval.db`,
      directory: AbsolutePath.make("/project"),
      model: EvalGraph.compactModel,
    })
    const sessionID = SessionV2.ID.make("ses_eval_anchor")

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
          title: "eval-anchor",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.GoalUpdated, {
        sessionID,
        timestamp: yield* DateTime.now,
        objective: "Ship the eval harness",
        acceptanceCriteria: [],
        constraints: [{ id: SessionGoal.ConstraintID.make("cons_anchor"), text: "Never call the destructive tool" }],
        sourceMessageIDs: [],
      })

      const session = yield* SessionV2.Service

      // Several separate exchanges, each moderately sized -- select() (compaction.ts) splits a
      // conversation into a "head" to compact and a token-budgeted "tail" to keep verbatim at
      // MESSAGE granularity, so a single giant message just becomes the whole tail with an empty
      // head and never compacts. Multiple real turns is what makes the head non-empty and lets
      // the cumulative total cross compactModel's context window on its own. Each round also
      // queues an unused "summary" response ahead of its real reply -- compaction only actually
      // fires once size crosses the (wide, deliberately generous) trigger/fits gap, so most
      // rounds never touch it and it just carries over to whichever round does.
      const turnPrompt = "Investigate the flaky test in the checkout pipeline. ".repeat(120)
      for (let round = 0; round < 12; round++) {
        handle.llm.push(FakeLLM.textTurn("Summary: investigating checkout flake.", "eval_summary"))
        handle.llm.push(FakeLLM.textTurn(`Looked at round ${round}.`))
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: `${turnPrompt} (round ${round})` }), resume: false })
        yield* session.resume(sessionID)
      }

      // Two real LLM.stream() calls: the compaction summarizer's own request, then the retried
      // main turn built from the now-compacted context.
      expect(handle.llm.requests.length).toBeGreaterThanOrEqual(2)

      const compactionEvents = yield* db.select().from(EventTable).pipe(Effect.orDie)
      expect(compactionEvents.some((row) => row.type === "session.next.compaction.ended.2")).toBe(true)

      const finalRequest = handle.llm.requests.at(-1)!
      const finalSystem = finalRequest.system.map((part) => part.text).join("\n")
      expect(finalSystem).toContain("Ship the eval harness")
      expect(finalSystem).toContain("Never call the destructive tool")
    }).pipe(Effect.scoped, Effect.provide(handle.layer), Effect.runPromise)
  })
})
