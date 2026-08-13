import type { SessionEntity } from "@/context/session-entities"

/**
 * Whether the entity store still considers this session part of active views. The home list asks
 * rather than deciding: a component that removed a row because its own HTTP call returned 200 is
 * precisely the second source of truth this slice removes.
 *
 * A `switch` with a `never`-typed default, not an if-chain: a third `_pending` status added to
 * `SessionEntities.EntityStatus` later must fail this file's typecheck, not silently fall through
 * to the `lifecycle.state` check below and stay listed. A standalone module (not inlined in
 * home-sessions-controller.tsx) so it can be unit tested without that file's heavy transitive
 * imports (markdown-cache's worker, solid-query, etc.) -- exactly because that gap is the bug
 * this function fixes: archive_pending/trash_pending previously weren't checked at all, so a row
 * only left the list once an authoritative snapshot confirmed it, not on the click that caused it.
 */
export function sessionEntityIsListed(entity: SessionEntity | undefined): boolean {
  // Unknown to the store means the store has not heard about it yet, not that it is gone — keep
  // showing it rather than blanking the list before the first snapshot lands.
  if (!entity?.value) return true
  switch (entity.status) {
    case "archive_pending":
    case "trash_pending":
      return false
    case "loading":
    case "ready":
    case "unavailable":
    case "missing":
    case "purged":
      return entity.value.lifecycle.state === "active"
    default: {
      const exhaustive: never = entity.status
      return exhaustive
    }
  }
}
