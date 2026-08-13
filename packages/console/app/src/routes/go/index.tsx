import { Navigate } from "@solidjs/router"

// Hidden (TKT-396 item 6, Ethan's ruling): a live pricing page for upstream's paid OpenCode Go
// subscription is squarely inside item 5's approved HIDE, same as the zen landing page in #45 --
// this removes only the promotional page and its nav entry points. The workspace-scoped billing
// page (workspace/[id]/go/index.tsx) is untouched: whether the fork keeps a billing surface at
// all is a separate product call, not an extension of this ruling.
export default function Go() {
  return <Navigate href="/" />
}
