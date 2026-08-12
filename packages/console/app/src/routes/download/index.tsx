import { Navigate } from "@solidjs/router"

// Hidden (TKT-396): no Draugur release pipeline exists yet, so this route no longer serves
// download UI (its backing API, [channel]/[platform].ts, is disabled the same way). Redirects
// home rather than 404ing since every inbound link to this route has been removed already --
// a stale bookmark or search-engine link should land somewhere useful, not a dead end.
export default function Download() {
  return <Navigate href="/" />
}
