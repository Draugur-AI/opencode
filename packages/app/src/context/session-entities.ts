/**
 * The one client-side truth about a session's existence and lifecycle.
 *
 * The app used to hold three: a sorted array merged by ID in `global-sync/bootstrap.ts`, tab
 * references validated against known *servers* rather than known *sessions* in `tabs.tsx`, and a
 * browser-only `opencode:session-tabs-removed` custom event dispatched on archive (deleted once
 * every consumer read this store instead — see `tabs.tsx`'s `reconcile()`). Race conditions
 * between three truths were not surprising, they were structural — an archived session could
 * flash back on an SSE race, and a delete could leave the sidebar stale until refresh.
 *
 * This module is the reducer those three collapsed into. It is deliberately free of Solid, of the
 * DOM, and of any transport: it is a pure function over (state, message) so that a property test
 * can drive it through generated deliveries — duplicated, reordered, delayed, gapped — without a
 * browser. The Solid store wrapper lives beside it; the rules live here.
 */

// Types come from the schema package the client is GENERATED FROM, not from a generated client.
// packages/app already depends on @opencode-ai/schema as workspace:*, so this is the canonical
// source rather than a second copy of the contract — and it sidesteps the vendored client entirely,
// which is a stale generation that does not know lifecycle exists (see FORK.md, TKT-328).
import type { Session } from "@opencode-ai/schema/session"

/**
 * `missing`, `unavailable` and `loading` are CLIENT observations, not server lifecycle states.
 * `purged` is durable and terminal: the server says the session is gone for good.
 */
export type EntityStatus =
  | "loading"
  | "ready"
  | "unavailable"
  | "missing"
  | "purged"
  /**
   * A mutation the user asked for that the server has not confirmed. Deliberately NOT a
   * fabricated final state: the design is explicit that optimistic UI may show `archive_pending`,
   * never a pretend `archived`. The authoritative lifecycle replaces it when it arrives, and a
   * failure rolls it back in one place instead of each component undoing its own guess.
   */
  | "archive_pending"
  | "trash_pending"

export interface SessionEntity {
  readonly value?: Session.Info
  readonly status: EntityStatus
  /** The `lifecycleRevision` this entity reflects. Absent until a snapshot or event supplies one. */
  readonly lifecycleRevision?: number
}

/** Entities are keyed by the FULL server scope and session ID: the same session ID on two servers
 * is two different things, and collapsing them is how a reconnect shows another server's state. */
export type EntityKey = string

export const entityKey = (serverKey: string, sessionID: string): EntityKey => `${serverKey} ${sessionID}`

/** Every entity for one server scope. The key format is `entityKey`'s alone to know -- callers
 * that want "all sessions for this server" (Archived, Trash) go through this rather than
 * hand-rolling a prefix, which is exactly the bug this replaces: a controller that reconstructed
 * the prefix by hand drifted from what `entityKey` actually produces (a stray null byte instead
 * of the space it looked like on screen) and silently rendered as empty, no error either side. */
export const entitiesForServer = (
  state: EntityState,
  serverKey: string,
): readonly (readonly [EntityKey, SessionEntity])[] => {
  const prefix = entityKey(serverKey, "")
  return Object.entries(state.entities).filter(([key]) => key.startsWith(prefix))
}

export interface EntityState {
  readonly entities: Readonly<Record<EntityKey, SessionEntity>>
  /**
   * Keys whose delivery looked impossible — a sequence gap, or a transition the lifecycle does not
   * allow. The owner must re-snapshot these rather than guess what it missed. Never inferred from
   * absence: a client that silently assumed is exactly what this store replaces.
   */
  readonly reconcile: readonly EntityKey[]
}

export const empty: EntityState = { entities: {}, reconcile: [] }

export type Message =
  /** A full server snapshot for one scope. Anything absent from it is `missing`, not merely stale. */
  | { readonly type: "snapshot"; readonly serverKey: string; readonly sessions: readonly Session.Info[] }
  /** One session fetched or streamed on its own. */
  | { readonly type: "session"; readonly serverKey: string; readonly session: Session.Info }
  | {
      readonly type: "lifecycle"
      readonly serverKey: string
      readonly sessionID: string
      readonly revision: number
      readonly to: Session.Info["lifecycle"]
    }
  /** The server confirmed this ID was permanently deleted. Terminal. */
  | { readonly type: "purged"; readonly serverKey: string; readonly sessionID: string }
  | { readonly type: "loading"; readonly serverKey: string; readonly sessionID: string }
  /** The user asked for a mutation; the server has not answered yet. */
  | {
      readonly type: "pending"
      readonly serverKey: string
      readonly sessionID: string
      readonly intent: "archive" | "trash"
    }
  /** The mutation failed. Roll the optimistic status back to what the entity actually holds. */
  | { readonly type: "pendingFailed"; readonly serverKey: string; readonly sessionID: string }
  /** The server holding these sessions is unreachable. An observation about the SERVER — it says
   * nothing about whether the sessions still exist, so it must not evict them. */
  | { readonly type: "serverUnavailable"; readonly serverKey: string }
  | { readonly type: "reconciled"; readonly keys: readonly EntityKey[] }

const withEntity = (state: EntityState, key: EntityKey, entity: SessionEntity): EntityState => ({
  ...state,
  entities: { ...state.entities, [key]: entity },
})

const needsReconcile = (state: EntityState, key: EntityKey): EntityState =>
  state.reconcile.includes(key) ? state : { ...state, reconcile: [...state.reconcile, key] }

/** Transitions the server lifecycle permits. A delivery outside this set means the client missed
 * something, so it re-snapshots rather than applying a state it cannot explain. */
const LEGAL: Record<string, readonly string[]> = {
  active: ["archived", "trash"],
  archived: ["active", "trash"],
  trash: ["active", "archived"],
}

export const reduce = (state: EntityState, message: Message): EntityState => {
  switch (message.type) {
    case "snapshot": {
      // A snapshot is authoritative for its scope: it both refreshes what it lists and settles
      // what it omits. This is what makes reconnect deterministic without a total-order stream.
      const entities = { ...state.entities }
      const seen = new Set<EntityKey>()
      for (const session of message.sessions) {
        const key = entityKey(message.serverKey, session.id)
        seen.add(key)
        // A purge is terminal and outranks a snapshot that still lists the session. A snapshot
        // taken before the purge, or in flight across it, would otherwise hand back a `ready`
        // entity and reopen a tab on a session the server has already destroyed — the one
        // resurrection no delivery order is allowed to produce.
        if (state.entities[key]?.status === "purged") continue
        entities[key] = { value: session, status: "ready", lifecycleRevision: session.lifecycleRevision }
      }
      for (const [key, entity] of Object.entries(state.entities)) {
        if (!key.startsWith(`${message.serverKey} `) || seen.has(key)) continue
        // A purge is durable; a snapshot that no longer lists it must not downgrade it to a
        // guess, or a purged tab could reopen as merely "missing" and be retried forever.
        entities[key] = entity.status === "purged" ? entity : { ...entity, status: "missing" }
      }
      return {
        entities,
        reconcile: state.reconcile.filter((key) => !key.startsWith(`${message.serverKey} `)),
      }
    }

    case "session": {
      const key = entityKey(message.serverKey, message.session.id)
      const current = state.entities[key]
      if (current?.status === "purged") return state
      if (
        current?.lifecycleRevision !== undefined &&
        message.session.lifecycleRevision < current.lifecycleRevision
      )
        return state
      return withEntity(state, key, {
        value: message.session,
        status: "ready",
        lifecycleRevision: message.session.lifecycleRevision,
      })
    }

    case "lifecycle": {
      const key = entityKey(message.serverKey, message.sessionID)
      const current = state.entities[key]
      if (current?.status === "purged") return state
      // Nothing known yet: the revision alone cannot be applied to a value we do not hold.
      if (!current?.value) return needsReconcile(state, key)

      const held = current.lifecycleRevision
      if (held !== undefined) {
        // Older than what we hold: a re-delivery or an out-of-order arrival. Ignore it — this is
        // the rule that stops a late event resurrecting an archived or deleted session.
        if (message.revision < held) return state
        // Same revision: idempotent only if it says the same thing. Disagreement means one of the
        // two is wrong and the client cannot tell which.
        if (message.revision === held)
          return message.to.state === current.value.lifecycle.state ? state : needsReconcile(state, key)
        // A gap: revisions advance by one per committed lifecycle event, so a jump means we
        // missed one and cannot know what it was.
        if (message.revision > held + 1) return needsReconcile(state, key)
      }

      if (!LEGAL[current.value.lifecycle.state]?.includes(message.to.state)) return needsReconcile(state, key)

      return withEntity(state, key, {
        value: { ...current.value, lifecycle: message.to, lifecycleRevision: message.revision },
        status: "ready",
        lifecycleRevision: message.revision,
      })
    }

    case "pending": {
      const key = entityKey(message.serverKey, message.sessionID)
      const current = state.entities[key]
      // Nothing optimistic may override a purge, and a session we do not hold cannot be pending.
      if (!current?.value || current.status === "purged") return state
      return withEntity(state, key, {
        ...current,
        status: message.intent === "archive" ? "archive_pending" : "trash_pending",
      })
    }

    case "pendingFailed": {
      const key = entityKey(message.serverKey, message.sessionID)
      const current = state.entities[key]
      if (!current || (current.status !== "archive_pending" && current.status !== "trash_pending")) return state
      // Back to what the entity actually holds, which the optimistic status never overwrote.
      return withEntity(state, key, { ...current, status: current.value ? "ready" : "loading" })
    }

    case "purged": {
      const key = entityKey(message.serverKey, message.sessionID)
      return withEntity(state, key, { ...state.entities[key], status: "purged" })
    }

    case "loading": {
      const key = entityKey(message.serverKey, message.sessionID)
      const current = state.entities[key]
      // Never downgrade something already settled into "loading".
      if (current && current.status !== "missing" && current.status !== "unavailable") return state
      return withEntity(state, key, { ...current, status: "loading" })
    }

    case "serverUnavailable": {
      const entities = { ...state.entities }
      for (const [key, entity] of Object.entries(state.entities)) {
        if (!key.startsWith(`${message.serverKey} `)) continue
        if (entity.status === "purged") continue
        entities[key] = { ...entity, status: "unavailable" }
      }
      return { ...state, entities }
    }

    case "reconciled":
      return { ...state, reconcile: state.reconcile.filter((key) => !message.keys.includes(key)) }
  }
}

export const get = (state: EntityState, serverKey: string, sessionID: string): SessionEntity | undefined =>
  state.entities[entityKey(serverKey, sessionID)]

/**
 * Whether a browser tab pointing at this session should survive reconciliation.
 *
 * `unavailable` deliberately KEEPS the tab: an unreachable server says nothing about whether the
 * session exists, and closing tabs because a laptop slept is the behaviour this replaces.
 */
export const tabSurvives = (entity: SessionEntity | undefined): boolean => {
  if (!entity) return true // not yet known; a snapshot will settle it
  switch (entity.status) {
    case "purged":
    case "missing":
      return false
    case "unavailable":
    case "loading":
      return true
    case "archive_pending":
    case "trash_pending":
      // The server has not agreed yet. Closing the tab now would have to be UNDONE on failure,
      // and a tab that reopens itself is worse than one that closes a moment later.
      return true
    case "ready":
      return entity.value?.lifecycle.state === "active"
  }
}

/** Whether a purged session must also be dropped from the recently-closed stack. */
export const forgetClosed = (entity: SessionEntity | undefined): boolean =>
  entity?.status === "purged" || entity?.status === "missing"
