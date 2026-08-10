/**
 * The session lifecycle transition model, encoded independently of the production reducer.
 *
 * This exists so a test can disagree with the implementation. Deriving the expected result from
 * `SessionLifecycle` would make every test a tautology: it would pass whatever the implementation
 * does, including the wrong thing. The states and edges here are transcribed from the design of
 * record ("State convergence needs model-based and property tests"), not from `src/`.
 *
 *     active  <-> archived
 *     active   -> trash
 *     archived -> trash
 *     trash    -> active or archived   (during the grace period)
 *     trash    -> purged               (after confirmation or expiry)
 *
 * `purged` is a terminal model state with no row behind it. Nothing leaves it.
 */

export type ModelState = "active" | "archived" | "trash" | "purged"

/**
 * `expectedRevision` is either absent (unconditional), the literal `"current"` meaning "whatever
 * the session holds right now" — which the driver resolves against the real row and the model
 * resolves against its own — or a concrete number, which the generator only ever emits as a stale
 * one. Without the `"current"` marker a generator could not produce a *passing* compare-and-set,
 * because it does not know the revisions the event log will assign.
 */
export type Expectation = number | "current"

export type Command =
  | { readonly verb: "archive"; readonly requestID: string; readonly expectedRevision?: Expectation }
  | { readonly verb: "restore"; readonly requestID: string; readonly expectedRevision?: Expectation }
  | { readonly verb: "trash"; readonly requestID: string; readonly expectedRevision?: Expectation }
  | { readonly verb: "restoreFromTrash"; readonly requestID: string; readonly expectedRevision?: Expectation }
  | { readonly verb: "purge"; readonly requestID: string }

export type Verb = Command["verb"]

/** What the model believes about a session: its state, its revision, and where trash returns it. */
export interface ModelSession {
  readonly state: ModelState
  readonly revision: number
  /** Where `restoreFromTrash` returns the session. Only meaningful while in trash. */
  readonly trashRestoreTo: "active" | "archived"
  /** Request IDs already applied. A repeat is recognised, not re-applied. */
  readonly applied: ReadonlyMap<string, number>
}

export const initial = (): ModelSession => ({
  state: "active",
  revision: 0,
  trashRestoreTo: "active",
  applied: new Map(),
})

/** Why a command did not change anything. */
export type Rejection = "transition" | "conflict" | "not-found"

export type Outcome =
  | { readonly kind: "applied"; readonly next: ModelSession }
  | { readonly kind: "duplicate"; readonly next: ModelSession }
  | { readonly kind: "rejected"; readonly reason: Rejection; readonly next: ModelSession }

const TARGET: Record<Exclude<Verb, "purge">, (session: ModelSession) => ModelState> = {
  archive: () => "archived",
  restore: () => "active",
  trash: () => "trash",
  // Only meaningful from trash. From any other state the target is the state it is already in,
  // which is never a legal edge — `restoreFromTrash` on a live session is not a restore at all.
  // Consulting a remembered `trashRestoreTo` here would let a stale memory authorise a move the
  // real system refuses; that divergence was found by this model disagreeing with the code, and
  // the code was right.
  restoreFromTrash: (session) => (session.state === "trash" ? session.trashRestoreTo : session.state),
}

const LEGAL: Record<ModelState, ReadonlySet<ModelState>> = {
  active: new Set<ModelState>(["archived", "trash"]),
  archived: new Set<ModelState>(["active", "trash"]),
  trash: new Set<ModelState>(["active", "archived", "purged"]),
  purged: new Set<ModelState>(),
}

export const legal = (from: ModelState, to: ModelState) => LEGAL[from].has(to)

/**
 * Apply one command. `revision` is the aggregate sequence the real system would assign, supplied by
 * the caller so the model does not have to guess how the event log numbers things.
 */
export const apply = (session: ModelSession, command: Command, revision: number): Outcome => {
  const previous = session.applied.get(command.requestID)
  if (previous !== undefined) return { kind: "duplicate", next: session }

  if (session.state === "purged") return { kind: "rejected", reason: "not-found", next: session }

  if (command.verb === "purge") {
    if (!legal(session.state, "purged")) return { kind: "rejected", reason: "transition", next: session }
    return {
      kind: "applied",
      next: { ...session, state: "purged", revision, applied: new Map(session.applied).set(command.requestID, revision) },
    }
  }

  const expected = command.expectedRevision === "current" ? session.revision : command.expectedRevision
  if (expected !== undefined && expected !== session.revision)
    return { kind: "rejected", reason: "conflict", next: session }

  const target = TARGET[command.verb](session)
  if (!legal(session.state, target)) return { kind: "rejected", reason: "transition", next: session }

  return {
    kind: "applied",
    next: {
      state: target,
      revision,
      // Entering trash records where it came from; leaving trash makes it meaningless again.
      trashRestoreTo: target === "trash" ? (session.state as "active" | "archived") : session.trashRestoreTo,
      applied: new Map(session.applied).set(command.requestID, revision),
    },
  }
}

/**
 * A deterministic pseudo-random source. Tests must be reproducible: a failing generated sequence is
 * only useful as a regression fixture if the same seed replays it exactly.
 */
export const rng = (seed: number) => {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >> 17
    state ^= state << 5
    state >>>= 0
    return state / 0x100000000
  }
}

export interface GenerateOptions {
  readonly seed: number
  readonly length: number
  /** How often a command carries an expected revision, and how often that revision is stale. */
  readonly staleRate?: number
  /** How often a command reuses an earlier request ID. */
  readonly duplicateRate?: number
}

/**
 * Generate a command sequence that deliberately includes illegal transitions, stale revisions and
 * duplicate request IDs. The point is not to drive the system through valid states — it is to
 * check that invalid ones are refused rather than absorbed.
 */
export const generate = (options: GenerateOptions): Command[] => {
  const next = rng(options.seed)
  const staleRate = options.staleRate ?? 0.25
  const duplicateRate = options.duplicateRate ?? 0.2
  const verbs: Verb[] = ["archive", "restore", "trash", "restoreFromTrash", "purge"]
  const issued: string[] = []
  const commands: Command[] = []

  for (let index = 0; index < options.length; index++) {
    const verb = verbs[Math.floor(next() * verbs.length)]!
    const reuse = issued.length > 0 && next() < duplicateRate
    const requestID = reuse ? issued[Math.floor(next() * issued.length)]! : `req-${options.seed}-${index}`
    if (!reuse) issued.push(requestID)
    if (verb === "purge") {
      commands.push({ verb, requestID })
      continue
    }
    const roll = next()
    const expectedRevision: Expectation | undefined =
      roll < staleRate
        ? Math.floor(next() * 3) + 900 // a revision no real sequence will have reached
        : roll < staleRate + 0.35
          ? "current"
          : undefined
    commands.push({ verb, requestID, ...(expectedRevision === undefined ? {} : { expectedRevision }) })
  }
  return commands
}
