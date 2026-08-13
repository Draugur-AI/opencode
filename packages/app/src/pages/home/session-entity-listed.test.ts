import { describe, expect, test } from "bun:test"
import type { SessionEntity } from "@/context/session-entities"
import { sessionEntityIsListed } from "./session-entity-listed"

const entity = (status: SessionEntity["status"], lifecycleState?: "active" | "archived" | "trash") =>
  ({
    status,
    value: lifecycleState === undefined ? undefined : { lifecycle: { state: lifecycleState } },
  }) as unknown as SessionEntity

describe("sessionEntityIsListed", () => {
  test("unknown to the store (no value yet) stays listed, not blanked before the first snapshot", () => {
    expect(sessionEntityIsListed(undefined)).toBe(true)
    expect(sessionEntityIsListed(entity("loading"))).toBe(true)
  })

  test("archive_pending with a still-active value is NOT listed -- the bug this fixes", () => {
    expect(sessionEntityIsListed(entity("archive_pending", "active"))).toBe(false)
  })

  test("trash_pending with a still-active value is NOT listed", () => {
    expect(sessionEntityIsListed(entity("trash_pending", "active"))).toBe(false)
  })

  test("a ready, active entity is listed", () => {
    expect(sessionEntityIsListed(entity("ready", "active"))).toBe(true)
  })

  test("a ready, archived entity is not listed -- the authoritative state, not an optimism", () => {
    expect(sessionEntityIsListed(entity("ready", "archived"))).toBe(false)
  })

  test("a purged entity is not listed", () => {
    expect(sessionEntityIsListed(entity("purged", "trash"))).toBe(false)
  })
})
