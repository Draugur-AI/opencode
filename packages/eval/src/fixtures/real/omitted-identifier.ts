export * as RealOmittedIdentifierFixture from "./omitted-identifier"

import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionHistorySearch } from "@opencode-ai/core/session/history-search"
import { HistoryTool } from "@opencode-ai/core/tool/history"
import { Fixture } from "../../fixture"
import { CompactionEpoch } from "../../compaction-epoch"
import { OmittedIdentifierScenario } from "../../scenarios/omitted-identifier"
import { RealFixture } from "../../real-fixture"

const { IDENTIFIER } = OmittedIdentifierScenario

/**
 * The real-model counterpart of fixtures/omitted-identifier.ts (scripted current arm) -- a real
 * qwen3-6 decides on its own whether to call history_search and what to answer, against the real
 * production graph (goal/ledger/history_search all real). Unlike the real BASELINE fixture,
 * which has no in-process hook and must drive many slow real filler turns to reach real
 * compaction, this uses CompactionEpoch.inject the same way the scripted fixture does -- that
 * the injection path is honest is already proven by compaction-anchor.test.ts (real trigger) and
 * PR2's real baseline fixtures (real trigger, real subprocess); re-proving it here with a real
 * model on top would only spend real-model minutes on a claim already covered elsewhere. What
 * this fixture spends its real-model budget on is the one thing nothing else covers: does an
 * ACTUAL reasoning model choose to call history_search and get the recall right.
 */
export const run: RealFixture.Fixture = Effect.fn("RealOmittedIdentifierFixture.run")(function* (handle) {
  const { db } = yield* Database.Service
  const directory = AbsolutePath.make("/project")
  const sessionID = SessionV2.ID.make(`ses_real_identifier_${Date.now()}`)

  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({ id: sessionID, project_id: Project.ID.global, slug: sessionID, directory: "/project", title: "real-fixture", version: "test" })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)

  const session = yield* SessionV2.Service

  yield* session.prompt({ sessionID, prompt: Prompt.make({ text: OmittedIdentifierScenario.initialPrompt }), resume: false })
  yield* session.resume(sessionID)

  yield* CompactionEpoch.inject({ sessionID, summary: OmittedIdentifierScenario.compactionSummary })

  const results = yield* SessionHistorySearch.search(db, { sessionID, query: IDENTIFIER })
  const found = results.results[0]
  if (!found) return [Fixture.check("history_search finds the omitted identifier", false, "no search results")]
  const sourceMessageID = found.messageID

  yield* session.prompt({ sessionID, prompt: Prompt.make({ text: OmittedIdentifierScenario.recallPrompt }), resume: false })
  yield* session.resume(sessionID)

  const messages = yield* session.context(sessionID)
  const assistantMessages = messages.filter(
    (m): m is Extract<SessionMessage.Message, { type: "assistant" }> => m.type === "assistant",
  )
  const toolCalls = assistantMessages.flatMap((m) =>
    m.content.filter((c): c is Extract<(typeof m.content)[number], { type: "tool" }> => c.type === "tool"),
  )
  const finalText = assistantMessages
    .flatMap((m) => m.content)
    .filter((c): c is Extract<(typeof assistantMessages)[number]["content"][number], { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("\n")

  return [
    Fixture.check("history_search finds the omitted identifier", true),
    Fixture.check("the model calls history_search on its own", toolCalls.some((c) => c.name === HistoryTool.searchName)),
    Fixture.check(
      "the model calls history_get on the cited source",
      toolCalls.some((c) => c.name === HistoryTool.getName),
    ),
    Fixture.check("the final answer contains the recovered identifier", finalText.includes(IDENTIFIER)),
    Fixture.check("the final answer cites the source message", finalText.includes(sourceMessageID)),
  ]
})
