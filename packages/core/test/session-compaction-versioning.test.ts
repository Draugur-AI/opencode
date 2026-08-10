import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Stream } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node])))

// TKT-318: the first real "versioned successor, old decoder kept" case in this codebase (the one
// prior precedent, tool.success v1->v2, deleted the old definition instead). This proves the
// mechanism actually works, not just that it typechecks.
describe("Compaction.Ended versioned successor", () => {
  it.effect("a raw version-1 stored event still decodes after Ended was bumped to version 2", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const sessionID = SessionV2.ID.make("ses_compaction_v1_row")

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
          title: sessionID,
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)

      // A hand-inserted row in the OLD (version 1) shape -- no telemetry fields, exactly what a
      // pre-slice-5 binary would have written. versionedType("session.next.compaction.ended", 1).
      yield* db
        .insert(EventSequenceTable)
        .values({ aggregate_id: sessionID, seq: 0 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(EventTable)
        .values({
          id: EventV2.ID.make("evt_compaction_v1_row"),
          aggregate_id: sessionID,
          seq: 0,
          type: "session.next.compaction.ended.1",
          data: {
            timestamp: DateTime.toEpochMillis(DateTime.makeUnsafe(1)),
            sessionID,
            messageID: SessionMessage.ID.create(),
            reason: "auto",
            text: "old-shape summary",
            recent: "old-shape recent",
          },
        })
        .run()
        .pipe(Effect.orDie)

      const decoded = yield* events.durable({ aggregateID: sessionID }).pipe(Stream.take(1), Stream.runCollect)
      const row = Array.from(decoded).at(0)
      expect(row).toBeDefined()
      expect(row?.type).toBe("session.next.compaction.ended")
      expect(row?.durable?.version).toBe(1)
      if (row?.type === "session.next.compaction.ended") {
        expect((row.data as { text: string }).text).toBe("old-shape summary")
        expect((row.data as { tokensBefore?: number }).tokensBefore).toBeUndefined()
      }
    }),
  )
})
