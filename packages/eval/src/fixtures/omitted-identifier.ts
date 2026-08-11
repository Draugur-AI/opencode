export * as OmittedIdentifierFixture from "./omitted-identifier"

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
import { FakeLLM } from "../fake-llm"
import { CompactionEpoch } from "../compaction-epoch"
import { Fixture } from "../fixture"
import { OmittedIdentifierScenario } from "../scenarios/omitted-identifier"

const { IDENTIFIER } = OmittedIdentifierScenario

/**
 * The design/build/validation posts' flagship retention scenario: an exact identifier is
 * mentioned once, a compaction summary genuinely omits it, and a later turn must recover it
 * through history_search -> history_get and cite the source message.
 */
export const run: Fixture.Fixture = Effect.fn("OmittedIdentifierFixture.run")(function* (handle) {
  const { db } = yield* Database.Service
  const directory = AbsolutePath.make("/project")
  const sessionID = SessionV2.ID.make(`ses_fixture_identifier_${Date.now()}`)

  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({ id: sessionID, project_id: Project.ID.global, slug: sessionID, directory: "/project", title: "fixture", version: "test" })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)

  const session = yield* SessionV2.Service

  handle.llm.push(FakeLLM.textTurn("Noted the connection details."))
  yield* session.prompt({
    sessionID,
    prompt: Prompt.make({ text: OmittedIdentifierScenario.initialPrompt }),
    resume: false,
  })
  yield* session.resume(sessionID)

  yield* CompactionEpoch.inject({
    sessionID,
    summary: OmittedIdentifierScenario.compactionSummary,
  })

  const results = yield* SessionHistorySearch.search(db, { sessionID, query: IDENTIFIER })
  const found = results.results[0]
  if (!found) return [Fixture.check("history_search finds the omitted identifier", false, "no search results")]
  const sourceMessageID = found.messageID

  handle.llm.resetRequests()
  handle.llm.push(FakeLLM.toolCallTurn("call_search", HistoryTool.searchName, { query: IDENTIFIER }))
  handle.llm.push(FakeLLM.toolCallTurn("call_get", HistoryTool.getName, { messageID: sourceMessageID }))
  handle.llm.push(FakeLLM.textTurn(`The host is ${OmittedIdentifierScenario.expectedAnswerFragment} (source: ${sourceMessageID}).`))

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
    Fixture.check(
      "the agent calls history_search",
      toolCalls.some((c) => c.name === HistoryTool.searchName),
    ),
    Fixture.check(
      "the agent calls history_get on the cited source",
      toolCalls.some((c) => c.name === HistoryTool.getName),
    ),
    Fixture.check("the final answer contains the recovered identifier", finalText.includes(IDENTIFIER)),
    Fixture.check("the final answer cites the source message", finalText.includes(sourceMessageID)),
  ]
})
