import { describe, expect, test } from "bun:test"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { EventManifest as SchemaEventManifest } from "@opencode-ai/schema/event-manifest"
import { Todo } from "@/session/todo"
import { EventManifest } from "@/event-manifest"

describe("public event manifest", () => {
  test("contains every latest public wire type once", () => {
    expect(EventManifest.Definitions).toBe(SchemaEventManifest.Definitions)
    expect(EventManifest.Latest).toBe(SchemaEventManifest.Latest)
    expect(EventManifest.Durable).toBe(SchemaEventManifest.Durable)
    // 93 since session.next.lifecycle.changed joined the manifest (89), then the goal/ledger
    // quartet (93). This assertion exists so that adding a public wire type is a deliberate
    // act; update the count with the addition.
    expect(EventManifest.Latest.size).toBe(93)
    expect(EventManifest.Latest.has("session.next.lifecycle.changed")).toBe(true)
    expect(EventManifest.Latest.has("session.next.goal.updated")).toBe(true)
    expect(EventManifest.Latest.has("session.next.goal.status_changed")).toBe(true)
    expect(EventManifest.Latest.has("session.next.ledger.added")).toBe(true)
    expect(EventManifest.Latest.has("session.next.ledger.superseded")).toBe(true)
    expect(EventManifest.Latest.get("session.next.step.ended")).toBe(SessionEvent.Step.Ended)
    expect(EventManifest.Latest.get("todo.updated")).toBe(Todo.Event.Updated)
    expect(EventManifest.Latest.has("ide.installed")).toBe(false)
    expect(EventManifest.Latest.has("server.connected")).toBe(true)
    expect(EventManifest.Latest.has("global.disposed")).toBe(true)
  })

  test("contains only the current step settlement versions", () => {
    expect(EventManifest.Durable.has("session.next.step.ended.1")).toBe(false)
    expect(EventManifest.Durable.get("session.next.step.ended.2")).toBe(SessionEvent.Step.Ended)
  })
})
