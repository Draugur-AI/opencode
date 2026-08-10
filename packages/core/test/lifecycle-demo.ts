/**
 * Capability demo for TKT-313. Not a test — it prints what an owner can now do that they could
 * not before. Run with: bun run test/lifecycle-demo.ts from packages/core.
 */
import { eq } from "drizzle-orm"
import { Effect, Exit } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionLifecycle } from "@opencode-ai/core/session/lifecycle"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"

const base = AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node]))
const sessions = AppNodeBuilder.build(SessionV2.node, [[SessionExecution.node, SessionExecution.noopLayer]])
const req = (value: string) => SessionLifecycle.RequestID.make(value)
const id = SessionV2.ID.make("ses_demo")

const show = (label: string, value: unknown) => console.log(`  ${label.padEnd(34)} ${JSON.stringify(value)}`)

const program = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const service = yield* SessionV2.Service

  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({ id, project_id: Project.ID.global, slug: "demo", directory: "/project", title: "demo", version: "d" })
    .run()
    .pipe(Effect.orDie)

  const state = () =>
    Effect.gen(function* () {
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, id)).get().pipe(Effect.orDie)
      return row ? { lifecycle: row.lifecycle, revision: row.lifecycle_revision } : "NO ROW"
    })

  const listed = (lifecycle: "active" | "archived" | "trash" | "all") =>
    service.list({ lifecycle }).pipe(Effect.map((rows) => rows.filter((row) => row.id === id).length))

  console.log("\n1. a new session is active, and revision 0 means no lifecycle change was committed")
  show("state", yield* state())
  show("appears in the default list", yield* listed("active"))

  console.log("\n2. archive: hidden from active views, discoverable in the archived view")
  const archived = yield* service.archive({ sessionID: id, requestID: req("demo-archive") })
  show("state", yield* state())
  show("lifecycle value", archived.lifecycle)
  show("in active list / archived list", [yield* listed("active"), yield* listed("archived")])

  console.log("\n3. a retry of that same request does not archive a second time")
  const retried = yield* service.archive({ sessionID: id, requestID: req("demo-archive") })
  show("revision unchanged", retried.lifecycleRevision === archived.lifecycleRevision)
  const events = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, id)).all().pipe(Effect.orDie)
  show("lifecycle events written", events.filter((e) => e.type.startsWith("session.next.lifecycle")).length)

  console.log("\n4. a stale writer cannot resurrect it: expected revision 0 is refused")
  const stale = yield* service
    .restore({ sessionID: id, requestID: req("demo-stale"), expectedLifecycleRevision: 0 })
    .pipe(Effect.exit)
  show("rejected", Exit.isFailure(stale))
  show("state after the refused write", yield* state())

  console.log("\n5. trash from archived, then restore -- it returns to ARCHIVED, not to active")
  yield* service.trash({ sessionID: id, requestID: req("demo-trash") })
  const trashed = yield* service.get(id)
  show("trash value carries a deadline", trashed.lifecycle)
  yield* service.restoreFromTrash({ sessionID: id, requestID: req("demo-untrash") })
  show("state", yield* state())

  console.log("\n6. permanent deletion requires the session ID echoed back")
  yield* service.trash({ sessionID: id, requestID: req("demo-trash-2") })
  const unconfirmed = yield* service
    .purge({ sessionID: id, requestID: req("demo-purge-bad"), confirmation: SessionV2.ID.make("ses_wrong") })
    .pipe(Effect.exit)
  show("refused without confirmation", Exit.isFailure(unconfirmed))

  console.log("\n7. purge: the row and its events are gone, a tombstone remains")
  const tombstone = yield* service.purge({ sessionID: id, requestID: req("demo-purge"), confirmation: id })
  show("session row", yield* state())
  const after = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, id)).all().pipe(Effect.orDie)
  show("durable events remaining", after.length)
  show("tombstone", { id: tombstone.id, lastLifecycleRevision: tombstone.lastLifecycleRevision })
  show("retrying the purge returns the same tombstone", (yield* service.purge({
    sessionID: id,
    requestID: req("demo-purge"),
    confirmation: id,
  })).id === tombstone.id)
  console.log("")
})

await Effect.runPromise(program.pipe(Effect.provide(sessions), Effect.provide(base), Effect.scoped) as Effect.Effect<void>)
