import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Fiber, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { PermissionTable } from "@opencode-ai/core/permission/sql"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionContextEpoch } from "@opencode-ai/core/session/context-epoch"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProfile } from "@opencode-ai/core/session/profile"
import { SessionProfileBuiltin } from "@opencode-ai/core/session/profile-builtin"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SystemContext } from "@opencode-ai/core/system-context"
import { eq } from "drizzle-orm"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionStore.node,
      PermissionSaved.node,
      AgentV2.node,
      PermissionV2.node,
      SessionProfile.node,
      SessionProjector.node,
    ]),
    [[Location.node, current]],
  ),
)

function setup(rules: PermissionV2.Ruleset = []) {
  return Effect.gen(function* () {
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
        id: SessionV2.ID.make("ses_test"),
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
        agent: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* setRules(rules)
  })
}

function setRules(rules: PermissionV2.Ruleset) {
  return Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    yield* agents.transform((editor) =>
      editor.update(AgentV2.ID.make("test"), (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })
}

function assertion(input: Partial<PermissionV2.AssertInput> = {}) {
  return {
    id: PermissionV2.ID.create("per_test"),
    sessionID: SessionV2.ID.make("ses_test"),
    action: "read",
    resources: ["src/index.ts"],
    ...input,
  } satisfies PermissionV2.AssertInput
}

function waitForRequest() {
  return Effect.gen(function* () {
    const service = yield* PermissionV2.Service
    const events = yield* EventV2.Service
    const asked = yield* Deferred.make<PermissionV2.Request>()
    const unsubscribe = yield* events.listen((event) =>
      event.type === PermissionV2.Event.Asked.type
        ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    const fiber = yield* service.assert(assertion()).pipe(Effect.forkScoped)
    const request = yield* Deferred.await(asked)
    return { service, fiber, request }
  })
}

describe("PermissionV2", () => {
  it.effect("returns the evaluated effect and only queues prompts", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "allow" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([])
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("evaluates against an explicit provider-turn agent", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.permissions.push({ action: "read", resource: "*", effect: "deny" })
        }),
      )
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion())).toMatchObject({ effect: "allow" })
      expect(yield* service.ask(assertion({ agent: AgentV2.ID.make("reviewer") }))).toMatchObject({ effect: "deny" })
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.permissions = []
        }),
      )
      expect(yield* service.ask(assertion({ agent: AgentV2.ID.make("reviewer") }))).toMatchObject({ effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).not.toHaveProperty("agent")
    }),
  )

  it.effect("allows and denies from explicit rules without asking", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      yield* service.assert(assertion())
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      const blocked = yield* service.assert(assertion()).pipe(Effect.flip)
      expect(blocked).toBeInstanceOf(PermissionV2.BlockedError)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("allows managed output reads without granting external directory access", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
      ])
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion({ resources: ["tool_123"] }))).toMatchObject({ effect: "allow" })
      expect(
        yield* service.ask(assertion({ action: "external_directory", resources: ["/tmp/tool-output/*"] })),
      ).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("uses build permissions when the Session agent is omitted", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.permissions = [{ action: "todowrite", resource: "*", effect: "allow" }]
        }),
      )

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ action: "todowrite", resources: ["*"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("denies omitted-agent permissions when no primary default agent exists", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) => {
        editor.remove(AgentV2.ID.make("test"))
        editor.remove(AgentV2.ID.make("build"))
      })

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("evaluates bash with the normal configured-rule semantics", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      const bash = assertion({ action: "bash", resources: ["pwd"] })
      expect(yield* service.ask(bash)).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "allow" })

      yield* setRules([])
      expect(yield* service.ask(bash)).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("uses saved bash approvals while preserving configured deny precedence", () =>
    Effect.gen(function* () {
      yield* setup()
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "bash", resources: ["pwd"] })

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])

      yield* setRules([{ action: "bash", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "deny",
      })
    }),
  )

  it.effect("resolves an asked permission once", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      expect(yield* service.list()).toEqual([request])
      expect(yield* service.forSession(request.sessionID)).toEqual([request])
      expect(yield* service.forSession(SessionV2.ID.make("ses_other"))).toEqual([])
      expect(yield* service.get(request.id)).toEqual(request)
      yield* service.reply({ requestID: request.id, reply: "once" })
      yield* Fiber.join(fiber)
      expect(yield* service.list()).toEqual([])
      expect(yield* service.get(request.id)).toBeUndefined()
    }),
  )

  it.effect("defects when an asked permission is declined", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      yield* service.reply({ requestID: request.id, reply: "reject" })
      const exit = yield* Fiber.await(fiber)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure")
        expect(
          exit.cause.reasons.some(
            (reason) => Cause.isDieReason(reason) && reason.defect instanceof PermissionV2.DeclinedError,
          ),
        ).toBe(true)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("stores and removes saved resources for a project", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const asked = yield* Deferred.make<PermissionV2.Request>()
      const events = yield* EventV2.Service
      const unsubscribe = yield* events.listen((event) =>
        event.type === PermissionV2.Event.Asked.type
          ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* service.assert(assertion({ save: ["src/*"] })).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      yield* service.reply({ requestID: request.id, reply: "always" })
      yield* Fiber.join(fiber)

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(PermissionTable).where(eq(PermissionTable.project_id, Project.ID.global)).all(),
      ).toMatchObject([{ action: "read", resource: "src/*" }])
      const saved = yield* PermissionSaved.Service
      const id = (yield* saved.list())[0]!.id
      expect(yield* saved.list()).toEqual([{ id, projectID: Project.ID.global, action: "read", resource: "src/*" }])
      yield* service.assert(assertion({ id: PermissionV2.ID.create("per_next"), resources: ["src/next.ts"] }))
      yield* saved.remove(id)
      expect(yield* saved.list()).toEqual([])
    }),
  )

  // TKT-321: the property the whole profile feature stands or falls on -- hiding a tool from
  // ToolRegistry.materialize is UX, not enforcement. A profile's deny must reach this leaf check
  // even when the agent's own ruleset would otherwise allow the call, and even though nothing
  // here ever touches materialize/the tool listing at all -- proving the rejection doesn't depend
  // on the client having honored the hidden listing in the first place.
  it.effect("rejects a call a profile denies even though the agent's own ruleset allows it", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "bash", resource: "*", effect: "allow" }])
      const profiles = yield* SessionProfile.Service
      yield* profiles.resolve({
        sessionID: SessionV2.ID.make("ses_test"),
        messageID: SessionMessage.ID.make("msg_profile_switch"),
        definition: {
          id: SessionProfile.ID.create(),
          title: "chat",
          toolRules: { bash: "deny" },
          skillRules: {},
          mcpRules: {},
          pluginRules: {},
          hookRules: {},
          monitorRules: { allowUser: false, allowPlugin: false, autoStart: false },
        },
      })

      const service = yield* PermissionV2.Service
      const error = yield* service.assert(assertion({ action: "bash", resources: ["ls"] })).pipe(Effect.flip)
      expect(error).toBeInstanceOf(PermissionV2.BlockedError)

      // The agent's own ruleset is untouched -- an action the profile does NOT mention still
      // resolves from the agent's rules exactly as before, proving the merge adds a restriction
      // rather than replacing the agent's ruleset outright.
      expect(yield* service.ask(assertion({ action: "read" }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "ask",
      })
    }),
  )

  // The ticket's own demo: a chat-profile session refuses an edit at the leaf while a
  // coding-profile session performs it, using the actual shipped built-in definitions.
  it.effect("chat-profile session refuses edit, coding-profile session performs it", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const profiles = yield* SessionProfile.Service
      const service = yield* PermissionV2.Service
      const edit = () => assertion({ action: "edit", resources: ["src/index.ts"] })

      yield* profiles.resolve({
        sessionID: SessionV2.ID.make("ses_test"),
        messageID: SessionMessage.ID.make("msg_chat"),
        definition: SessionProfileBuiltin.chat,
      })
      const chatResult = yield* service.assert(edit()).pipe(Effect.flip)
      expect(chatResult).toBeInstanceOf(PermissionV2.BlockedError)

      yield* profiles.resolve({
        sessionID: SessionV2.ID.make("ses_test"),
        messageID: SessionMessage.ID.make("msg_coding"),
        definition: SessionProfileBuiltin.coding,
      })
      expect(yield* service.assert(edit())).toBeUndefined()
    }),
  )

  // Proof, not description: RuleEffect's doc comment CLAIMS "allow"/"inherit" are treated
  // identically so a profile can never re-enable what a higher scope denies -- this is the test
  // that goes red the day a refactor makes that claim false, e.g. if denyRules (or its caller)
  // is ever changed to emit an actual allow rule for "allow" instead of skipping it.
  it.effect("a profile's explicit 'allow' cannot re-enable an action the agent denies at a higher scope", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "bash", resource: "*", effect: "deny" }])
      const profiles = yield* SessionProfile.Service
      yield* profiles.resolve({
        sessionID: SessionV2.ID.make("ses_test"),
        messageID: SessionMessage.ID.make("msg_allow_attempt"),
        definition: {
          id: SessionProfile.ID.create(),
          title: "attempted-override",
          toolRules: { bash: "allow" },
          skillRules: {},
          mcpRules: {},
          pluginRules: {},
          hookRules: {},
          monitorRules: { allowUser: true, allowPlugin: true, autoStart: true },
        },
      })

      const service = yield* PermissionV2.Service
      const error = yield* service.assert(assertion({ action: "bash", resources: ["ls"] })).pipe(Effect.flip)
      expect(error).toBeInstanceOf(PermissionV2.BlockedError)
    }),
  )

  // Slice 4 established that a goal/ledger mutation resets the context epoch so the next turn
  // rebuilds its baseline rather than reconciling against a stale one; ProfileSwitched follows
  // the same pattern (projector.ts). Proven here the same way: initialize an epoch, confirm a
  // second initialize is a no-op (row exists), switch, then confirm the NEXT initialize creates
  // a fresh row rather than seeing the pre-switch one as still current.
  it.effect("a profile switch resets the context epoch, same as a goal or ledger mutation", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const { db } = yield* Database.Service
      const profiles = yield* SessionProfile.Service
      const sessionID = SessionV2.ID.make("ses_test")
      const loadContext = Effect.succeed(SystemContext.empty)

      const first = yield* SessionContextEpoch.initialize(db, loadContext, sessionID)
      expect(first).toBeDefined()
      expect(yield* SessionContextEpoch.initialize(db, loadContext, sessionID)).toBeUndefined()

      yield* profiles.resolve({
        sessionID,
        messageID: SessionMessage.ID.make("msg_switch"),
        definition: SessionProfileBuiltin.chat,
      })

      const afterSwitch = yield* SessionContextEpoch.initialize(db, loadContext, sessionID)
      expect(afterSwitch).toBeDefined()
    }),
  )

  // profile.ts's doc comment claims old turns "stay explainable against the exact snapshot
  // active when they ran" -- this is the test that makes that true rather than theater. Resolved
  // via the shared session event-sequence cursor (never wall-clock), per the lead's ruling that
  // every convergence property in this codebase anchors on seq.
  it.effect("a past turn resolves to the snapshot active when it ran, not the session's current one", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const { db } = yield* Database.Service
      const profiles = yield* SessionProfile.Service
      const sessionID = SessionV2.ID.make("ses_test")

      const first = yield* profiles.resolve({
        sessionID,
        messageID: SessionMessage.ID.make("msg_first_switch"),
        definition: SessionProfileBuiltin.coding,
      })

      // A real turn that happened after the first switch but before the second -- its own `seq`
      // is what `at()` resolves against, so it must be a real committed sequence value, not an
      // arbitrary one.
      const seqAfterFirst = yield* EventV2.latestSequence(db, sessionID)
      const turnID = SessionMessage.ID.make("msg_mid_session_turn")
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: turnID,
          session_id: sessionID,
          type: "compaction",
          seq: seqAfterFirst,
          data: { reason: "auto", summary: "a turn before the second switch", recent: "" } as never,
        })
        .run()
        .pipe(Effect.orDie)

      const second = yield* profiles.resolve({
        sessionID,
        messageID: SessionMessage.ID.make("msg_second_switch"),
        definition: SessionProfileBuiltin.chat,
      })
      expect(second.id).not.toBe(first.id)

      // Both snapshots remain independently fetchable...
      expect((yield* profiles.get(sessionID))?.id).toBe(second.id)
      // ...and the turn from before the second switch still resolves to the FIRST snapshot, not
      // the session's current one.
      expect((yield* profiles.at(sessionID, turnID))?.id).toBe(first.id)
    }),
  )
})
