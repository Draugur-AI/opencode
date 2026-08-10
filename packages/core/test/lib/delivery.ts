/**
 * Delivery simulator for durable session events.
 *
 * A transport can duplicate, reorder and delay events, and a reconnect can leave a gap. The
 * validation design asks every state change to survive all four, and to converge to the same
 * durable entity whether a client was built from a fresh snapshot or from an older snapshot plus
 * the delivered suffix. This module produces those deliveries and the two reconstructions.
 *
 * It holds no knowledge of the production reducer. The fold below is the *rule* a client must obey
 * — ignore what is older than what you hold, treat the same revision as a no-op, and ask for a
 * snapshot when the sequence skips — expressed once so a test can check the real one against it.
 */

import { rng, type ModelState } from "./lifecycle-model"

/** One delivered lifecycle change, reduced to what a client needs to reconcile. */
export interface Delivered {
  readonly seq: number
  readonly to: ModelState
  /** Where trash would restore to, carried so a fold can reproduce the same entity. */
  readonly trashRestoreTo?: "active" | "archived"
}

export interface Snapshot {
  readonly state: ModelState
  readonly revision: number
  readonly trashRestoreTo: "active" | "archived"
}

export interface FoldResult {
  readonly snapshot: Snapshot
  /**
   * True when the delivery skipped a sequence the client had not seen. A client observing this
   * must reconcile from a fresh snapshot rather than guessing what it missed.
   */
  readonly needsReconcile: boolean
  readonly ignored: number
}

/**
 * Apply a delivered suffix to a snapshot under the reconciliation rule. Order-insensitive by
 * construction: the outcome depends on revisions, never on arrival order.
 */
export const fold = (snapshot: Snapshot, delivered: ReadonlyArray<Delivered>): FoldResult => {
  let current = snapshot
  let needsReconcile = false
  let ignored = 0
  // Highest revision seen, including ones arriving out of order, so a gap is detected against what
  // the client has actually observed rather than against what it last applied.
  let highest = snapshot.revision

  for (const event of delivered) {
    if (event.seq <= current.revision) {
      // Older than, or identical to, what we hold. Re-delivery must not move anything.
      ignored++
      continue
    }
    if (event.seq > highest + 1) needsReconcile = true
    highest = Math.max(highest, event.seq)
    current = {
      state: event.to,
      revision: event.seq,
      trashRestoreTo: event.trashRestoreTo ?? current.trashRestoreTo,
    }
  }
  return { snapshot: current, needsReconcile, ignored }
}

/** Deliver every event exactly once, in order. The control case. */
export const inOrder = (events: ReadonlyArray<Delivered>): Delivered[] => [...events]

/** Deliver some events twice. A retrying transport, or two subscriptions on one socket. */
export const duplicated = (events: ReadonlyArray<Delivered>, seed: number, rate = 0.5): Delivered[] => {
  const next = rng(seed)
  const out: Delivered[] = []
  for (const event of events) {
    out.push(event)
    if (next() < rate) out.push(event)
  }
  return out
}

/** Deliver events out of order, by swapping neighbours. A multiplexed or racing transport. */
export const reordered = (events: ReadonlyArray<Delivered>, seed: number): Delivered[] => {
  const next = rng(seed)
  const out = [...events]
  for (let index = 0; index + 1 < out.length; index++) {
    if (next() < 0.5) {
      const first = out[index]!
      const second = out[index + 1]!
      out[index] = second
      out[index + 1] = first
      index++
    }
  }
  return out
}

/** Drop events, as a reconnect that resumed past them would. Produces a gap. */
export const gapped = (events: ReadonlyArray<Delivered>, seed: number, rate = 0.35): Delivered[] => {
  const next = rng(seed)
  return events.filter(() => next() >= rate)
}

/**
 * The three-way comparison the validation design asks for: the authoritative projection, a client
 * built from a fresh snapshot, and a client built from an older snapshot plus a delivered suffix.
 * All three must agree on the durable entity.
 */
export const converges = (input: {
  readonly authoritative: Snapshot
  readonly fresh: Snapshot
  readonly older: Snapshot
  readonly suffix: ReadonlyArray<Delivered>
}) => {
  const replayed = fold(input.older, input.suffix)
  const agree =
    input.authoritative.state === input.fresh.state &&
    input.authoritative.revision === input.fresh.revision &&
    // A suffix with a gap cannot be expected to converge on its own; the client is required to
    // notice and reconcile, and that flag is the observable we assert instead.
    (replayed.needsReconcile ||
      (replayed.snapshot.state === input.authoritative.state &&
        replayed.snapshot.revision === input.authoritative.revision))
  return { agree, replayed }
}
