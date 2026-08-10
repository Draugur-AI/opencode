import { describe, expect } from "bun:test"
import { and, eq } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionHistorySearch } from "@opencode-ai/core/session/history-search"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))

let seq = 0
const seed = () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const id = SessionV2.ID.make(`ses_history_${seq++}`)
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

describe("SessionHistorySearch: population via the real event pipeline", () => {
  it.effect("publishing a Prompted event indexes it for search without any direct index() call", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const sessionID = yield* seed()

      yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: yield* DateTime.now,
        prompt: Prompt.make({ text: "the deployment key is xyzzy-plugh-77213" }),
        delivery: "steer",
      })

      const found = yield* SessionHistorySearch.search(db, { sessionID, query: "xyzzy-plugh-77213" })
      expect(found.results).toHaveLength(1)
      expect(found.results[0]?.snippet).toContain("xyzzy-plugh-77213")
    }),
  )
})

describe("SessionHistorySearch: caps", () => {
  it.effect("search truncates results at MaxResults and reports truncated", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = yield* seed()

      for (let i = 0; i < SessionHistorySearch.MaxResults + 5; i++) {
        yield* SessionHistorySearch.index(db, {
          sessionID,
          messageID: SessionMessage.ID.create(),
          seq: i,
          message: SessionMessage.User.make({
            id: SessionMessage.ID.create(),
            type: "user",
            text: `entry number ${i} mentions the word needle`,
            files: [],
            agents: [],
            time: { created: yield* DateTime.now },
          }),
        })
      }

      const found = yield* SessionHistorySearch.search(db, { sessionID, query: "needle" })
      expect(found.results).toHaveLength(SessionHistorySearch.MaxResults)
      expect(found.truncated).toBe(true)
    }),
  )

  it.effect("search snippets never exceed MaxSnippetBytes", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = yield* seed()

      yield* SessionHistorySearch.index(db, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        seq: 0,
        message: SessionMessage.User.make({
          id: SessionMessage.ID.create(),
          type: "user",
          text: `needle ${"word ".repeat(500)}`,
          files: [],
          agents: [],
          time: { created: yield* DateTime.now },
        }),
      })

      const found = yield* SessionHistorySearch.search(db, { sessionID, query: "needle" })
      expect(found.results).toHaveLength(1)
      expect(Buffer.byteLength(found.results[0]!.snippet, "utf8")).toBeLessThanOrEqual(
        SessionHistorySearch.MaxSnippetBytes,
      )
    }),
  )

  it.effect("get caps the neighborhood at MaxNeighborhood on each side", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = yield* seed()
      const targetID = SessionMessage.ID.create()

      for (let i = 0; i < SessionHistorySearch.MaxNeighborhood * 2 + 5; i++) {
        const id = i === SessionHistorySearch.MaxNeighborhood + 5 ? targetID : SessionMessage.ID.create()
        yield* db
          .insert(SessionMessageTable)
          .values({
            id,
            session_id: sessionID,
            type: "user",
            seq: i,
            time_created: 0,
            data: { text: `entry ${i}`, files: [], agents: [], time: { created: 0 } } as never,
          })
          .run()
          .pipe(Effect.orDie)
      }

      const entries = yield* SessionHistorySearch.get(db, {
        sessionID,
        messageID: targetID,
        before: 1000, // requests far more than the cap
        after: 1000,
      })
      expect(entries).toBeDefined()
      expect(entries!.length).toBeLessThanOrEqual(SessionHistorySearch.MaxNeighborhood * 2 + 1)
    }),
  )
})

describe("SessionHistorySearch: retrieval only", () => {
  it.effect("search and get never write to session_message -- pure reads", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = yield* seed()
      const messageID = SessionMessage.ID.create()

      yield* SessionHistorySearch.index(db, {
        sessionID,
        messageID,
        seq: 0,
        message: SessionMessage.User.make({
          id: messageID,
          type: "user",
          text: "retrieval only, never auto-injected",
          files: [],
          agents: [],
          time: { created: yield* DateTime.now },
        }),
      })

      const before = yield* db
        .select({ n: SessionMessageTable.id })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)

      yield* SessionHistorySearch.search(db, { sessionID, query: "retrieval" })
      yield* SessionHistorySearch.get(db, { sessionID, messageID })

      const after = yield* db
        .select({ n: SessionMessageTable.id })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)

      // No new session_message row was created by calling search/get -- the tool CALL itself
      // becomes a transcript entry (same as any other tool), but the retrieval functions
      // themselves never write, and never construct a synthetic "here is the full transcript"
      // message the way an auto-inject would.
      expect(after).toEqual(before)
    }),
  )
})

describe("TKT-318 done-condition: recover an identifier the compaction summary omitted", () => {
  it.effect("history_search finds the omitted identifier and cites its source message; history_get reads it back in full, within the configured byte caps", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const sessionID = yield* seed()

      const originalMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        messageID: originalMessageID,
        timestamp: yield* DateTime.now,
        prompt: Prompt.make({
          text: "The staging database connection is failing with error ECONNREFUSED at host 10.20.30.40 port 5432. Can you figure out why?",
        }),
        delivery: "steer",
      })

      // A realistic lossy compaction: the summary captures the gist, not the exact identifier.
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: yield* DateTime.now,
        reason: "auto",
        text: "User reported the staging database is unreachable. Investigating connectivity.",
        recent: "",
        tokensBefore: 500,
        retainedTailMessages: 0,
        retainedTailTokens: 0,
        summaryBytes: 80,
        summaryTokens: 20,
        durationMs: 50,
        sourceSeqStart: 0,
        sourceSeqEnd: 0,
      })

      // Confirm the omission is real: the compacted summary itself genuinely does not contain
      // the exact host:port, so recovering it can only come from durable history, not the
      // summary. Filtered to the compaction row specifically -- the original prompted message
      // (which DOES contain the IP) is a separate session_message row.
      const compactionRow = yield* db
        .select({ data: SessionMessageTable.data })
        .from(SessionMessageTable)
        .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "compaction")))
        .all()
        .pipe(Effect.orDie)
      const summaryText = JSON.stringify(compactionRow)
      expect(summaryText).not.toContain("10.20.30.40")

      const found = yield* SessionHistorySearch.search(db, { sessionID, query: "10.20.30.40" })
      expect(found.results).toHaveLength(1)
      expect(found.results[0]?.messageID).toBe(originalMessageID)
      expect(found.results[0]?.snippet).toContain("10.20.30.40")
      expect(Buffer.byteLength(found.results[0]!.snippet, "utf8")).toBeLessThanOrEqual(
        SessionHistorySearch.MaxSnippetBytes,
      )

      const entries = yield* SessionHistorySearch.get(db, { sessionID, messageID: originalMessageID })
      expect(entries).toBeDefined()
      const cited = entries!.find((entry) => entry.message.id === originalMessageID)
      expect(cited).toBeDefined()
      expect(cited?.message.type).toBe("user")
      if (cited?.message.type === "user") {
        expect(cited.message.text).toContain("ECONNREFUSED at host 10.20.30.40 port 5432")
      }
    }),
  )
})
