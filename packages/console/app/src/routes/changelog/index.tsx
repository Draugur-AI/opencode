import { Navigate } from "@solidjs/router"

// Hidden (TKT-396 item 6, Ethan's ruling): rendered github.com/anomalyco/opencode's own release
// history as if it were this fork's changelog -- a misrepresentation, not a cosmetic identity
// issue, since this fork has no releases of its own. Restore this page once the fork actually
// publishes its own releases and lib/changelog.ts has something real to point at.
export default function Changelog() {
  return <Navigate href="/" />
}
