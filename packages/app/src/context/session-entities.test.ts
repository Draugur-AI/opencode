import { describe, expect, test } from "bun:test"
import * as Model from "@opencode-ai/test-rig/lifecycle-model"
import * as Delivery from "@opencode-ai/test-rig/delivery"
import * as Entities from "./session-entities"

/**
 * These drive the reducer through the milestone-0 rig rather than through the UI. The rig's model
 * is written independently of this reducer, so a disagreement means one of them is wrong — which
 * is the point. On slice 1 that exact setup caught two real defects in the production code.
 */

const SERVER = "server-a"
const OTHER = "server-b"

const session = (id: string, state: "active" | "archived" | "trash", revision: number) =>
  ({
    id,
    projectID: "p",
    title: id,
    lifecycle:
      state === "active"
        ? { state: "active" }
        : state === "archived"
          ? { state: "archived", at: 1 }
          : { state: "trash", at: 1, purgeAfter: 2 },
    lifecycleRevision: revision,
    // The reducer only reads id/lifecycle/lifecycleRevision; the rest of Session.Info is irrelevant
    // to it, and pinning a full fixture here would couple these tests to unrelated schema churn.
  }) as unknown as Parameters<typeof Entities.reduce>[1] extends never ? never : any

const snapshot = (sessions: unknown[], serverKey = SERVER) =>
  ({ type: "snapshot", serverKey, sessions }) as Entities.Message

describe("session entity reducer", () => {
  test("a snapshot settles what it omits, and marks it missing rather than dropping it", () => {
    let state = Entities.reduce(Entities.empty, snapshot([session("s1", "active", 1), session("s2", "active", 1)]))
    state = Entities.reduce(state, snapshot([session("s1", "active", 1)]))

    expect(Entities.get(state, SERVER, "s1")?.status).toBe("ready")
    expect(Entities.get(state, SERVER, "s2")?.status).toBe("missing")
  })

  test("a snapshot for one server leaves another server's entities alone", () => {
    let state = Entities.reduce(Entities.empty, snapshot([session("s1", "active", 1)]))
    state = Entities.reduce(state, snapshot([session("s9", "active", 1)], OTHER))

    expect(Entities.get(state, SERVER, "s1")?.status).toBe("ready")
    expect(Entities.get(state, OTHER, "s9")?.status).toBe("ready")
  })

  test("an older revision cannot move an entity", () => {
    let state = Entities.reduce(Entities.empty, snapshot([session("s1", "archived", 5)]))
    state = Entities.reduce(state, {
      type: "lifecycle",
      serverKey: SERVER,
      sessionID: "s1",
      revision: 4,
      to: { state: "active" } as never,
    })

    // The late event is the one that used to make an archived session flash back.
    expect(Entities.get(state, SERVER, "s1")?.value?.lifecycle.state).toBe("archived")
    expect(Entities.get(state, SERVER, "s1")?.lifecycleRevision).toBe(5)
  })

  test("the same revision is idempotent, but a contradiction at the same revision asks to reconcile", () => {
    const base = Entities.reduce(Entities.empty, snapshot([session("s1", "archived", 5)]))

    const same = Entities.reduce(base, {
      type: "lifecycle",
      serverKey: SERVER,
      sessionID: "s1",
      revision: 5,
      to: { state: "archived", at: 1 } as never,
    })
    expect(same.reconcile).toEqual([])

    const contradiction = Entities.reduce(base, {
      type: "lifecycle",
      serverKey: SERVER,
      sessionID: "s1",
      revision: 5,
      to: { state: "active" } as never,
    })
    expect(contradiction.reconcile).toContain(Entities.entityKey(SERVER, "s1"))
  })

  test("a sequence gap asks to reconcile instead of guessing what was missed", () => {
    const base = Entities.reduce(Entities.empty, snapshot([session("s1", "active", 1)]))
    const gapped = Entities.reduce(base, {
      type: "lifecycle",
      serverKey: SERVER,
      sessionID: "s1",
      revision: 7,
      to: { state: "archived", at: 1 } as never,
    })

    expect(gapped.reconcile).toContain(Entities.entityKey(SERVER, "s1"))
    expect(Entities.get(gapped, SERVER, "s1")?.value?.lifecycle.state).toBe("active")
  })

  test("an unreachable server marks entities unavailable WITHOUT evicting them", () => {
    let state = Entities.reduce(Entities.empty, snapshot([session("s1", "active", 1)]))
    state = Entities.reduce(state, { type: "serverUnavailable", serverKey: SERVER })

    const entity = Entities.get(state, SERVER, "s1")
    expect(entity?.status).toBe("unavailable")
    expect(entity?.value).toBeDefined()
    // Closing a tab because a laptop slept is the behaviour this replaces.
    expect(Entities.tabSurvives(entity)).toBe(true)
  })

  test("purged is terminal: no message of any kind brings it back", () => {
    let state = Entities.reduce(Entities.empty, snapshot([session("s1", "active", 1)]))
    state = Entities.reduce(state, { type: "purged", serverKey: SERVER, sessionID: "s1" })

    for (const message of [
      snapshot([session("s1", "active", 9)]),
      { type: "session", serverKey: SERVER, session: session("s1", "active", 9) } as Entities.Message,
      {
        type: "lifecycle",
        serverKey: SERVER,
        sessionID: "s1",
        revision: 9,
        to: { state: "active" },
      } as unknown as Entities.Message,
      { type: "loading", serverKey: SERVER, sessionID: "s1" } as Entities.Message,
      { type: "serverUnavailable", serverKey: SERVER } as Entities.Message,
    ]) {
      state = Entities.reduce(state, message)
      expect(Entities.get(state, SERVER, "s1")?.status).toBe("purged")
      expect(Entities.tabSurvives(Entities.get(state, SERVER, "s1"))).toBe(false)
      expect(Entities.forgetClosed(Entities.get(state, SERVER, "s1"))).toBe(true)
    }
  })
})

describe("session entity reducer — optimistic pendings", () => {
  test("a pending intent hides the row from active views WITHOUT claiming the final state", () => {
    let state = Entities.reduce(Entities.empty, snapshot([session("s1", "active", 1)]))
    state = Entities.reduce(state, { type: "pending", serverKey: SERVER, sessionID: "s1", intent: "archive" })

    const entity = Entities.get(state, SERVER, "s1")
    expect(entity?.status).toBe("archive_pending")
    // The lifecycle is untouched: the server has not agreed, so nothing pretends it has.
    expect(entity?.value?.lifecycle.state).toBe("active")
    // The tab stays until the server confirms — a tab that reopens itself on failure is worse
    // than one that closes a moment later.
    expect(Entities.tabSurvives(entity)).toBe(true)
  })

  test("a failed mutation rolls the pending back in one place", () => {
    let state = Entities.reduce(Entities.empty, snapshot([session("s1", "active", 1)]))
    state = Entities.reduce(state, { type: "pending", serverKey: SERVER, sessionID: "s1", intent: "trash" })
    state = Entities.reduce(state, { type: "pendingFailed", serverKey: SERVER, sessionID: "s1" })

    expect(Entities.get(state, SERVER, "s1")?.status).toBe("ready")
    expect(Entities.get(state, SERVER, "s1")?.value?.lifecycle.state).toBe("active")
  })

  test("the authoritative lifecycle replaces a pending rather than racing it", () => {
    let state = Entities.reduce(Entities.empty, snapshot([session("s1", "active", 1)]))
    state = Entities.reduce(state, { type: "pending", serverKey: SERVER, sessionID: "s1", intent: "archive" })
    state = Entities.reduce(state, {
      type: "lifecycle",
      serverKey: SERVER,
      sessionID: "s1",
      revision: 2,
      to: { state: "archived", at: 1 } as never,
    })

    expect(Entities.get(state, SERVER, "s1")?.status).toBe("ready")
    expect(Entities.get(state, SERVER, "s1")?.value?.lifecycle.state).toBe("archived")
  })

  test("nothing optimistic may override a purge", () => {
    let state = Entities.reduce(Entities.empty, snapshot([session("s1", "active", 1)]))
    state = Entities.reduce(state, { type: "purged", serverKey: SERVER, sessionID: "s1" })
    state = Entities.reduce(state, { type: "pending", serverKey: SERVER, sessionID: "s1", intent: "archive" })

    expect(Entities.get(state, SERVER, "s1")?.status).toBe("purged")
  })
})


describe("session entity reducer — generated deliveries", () => {
  // Fixed seeds: a failing sequence is only useful as a regression fixture if it replays exactly.
  for (const seed of [1, 7, 42, 1337, 90210]) {
    test(`no delivery order resurrects a tombstoned session (seed ${seed})`, () => {
      const commands = Model.generate({ seed, length: 20 })
      let state = Entities.reduce(Entities.empty, snapshot([session("s1", "active", 0)]))
      state = Entities.reduce(state, { type: "purged", serverKey: SERVER, sessionID: "s1" })

      // Replay every generated command as a delivery, in order, duplicated, and reversed.
      const deliveries = commands.map((command, index) => ({
        type: "lifecycle" as const,
        serverKey: SERVER,
        sessionID: "s1",
        revision: index + 1,
        to: (command.verb === "trash"
          ? { state: "trash", at: 1, purgeAfter: 2 }
          : command.verb === "archive"
            ? { state: "archived", at: 1 }
            : { state: "active" }) as never,
      }))

      for (const order of [deliveries, [...deliveries, ...deliveries], [...deliveries].reverse()]) {
        let replayed = state
        for (const delivery of order) replayed = Entities.reduce(replayed, delivery)
        expect(Entities.get(replayed, SERVER, "s1")?.status).toBe("purged")
        expect(Entities.tabSurvives(Entities.get(replayed, SERVER, "s1"))).toBe(false)
      }
    })

    test(`snapshot-plus-suffix converges with a fresh snapshot (seed ${seed})`, () => {
      // Build an authoritative history the way the server would: one revision per applied change.
      let model = Model.initial()
      const history: Delivery.Delivered[] = []
      let revision = 0
      for (const command of Model.generate({ seed, length: 20 })) {
        if (command.verb === "purge") continue
        const outcome = Model.apply(model, command, revision + 1)
        if (outcome.kind !== "applied") continue
        revision += 1
        model = outcome.next
        history.push({ seq: revision, to: model.state, trashRestoreTo: model.trashRestoreTo })
      }
      if (history.length === 0) return

      const authoritative: Delivery.Snapshot = {
        state: model.state,
        revision,
        trashRestoreTo: model.trashRestoreTo,
      }

      for (const deliver of [
        Delivery.inOrder,
        (events: Delivery.Delivered[]) => Delivery.duplicated(events, seed),
        (events: Delivery.Delivered[]) => Delivery.reordered(events, seed),
        (events: Delivery.Delivered[]) => Delivery.gapped(events, seed),
      ]) {
        const result = Delivery.converges({
          authoritative,
          fresh: authoritative,
          older: { state: "active", revision: 0, trashRestoreTo: "active" },
          suffix: deliver(history),
        })
        // A gapped suffix is allowed to fail to converge ONLY by asking to reconcile — never by
        // silently landing somewhere else.
        expect(result.agree).toBe(true)
      }
    })
  }
})
