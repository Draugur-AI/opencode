import { Navigate } from "@solidjs/router"

// Hidden (TKT-396 item 6, Ethan's ruling): a live marketing page for upstream's SSO/self-hosting
// enterprise offering is inside item 2's approved pattern, same reasoning as /go and /zen -- this
// removes only the promotional page and its nav entry point. The backing api/enterprise.ts
// (Salesforce lead creation, upstream's own contact@anoma.ly inbox) is disabled separately, since
// it has no caller left once this page is gone.
export default function Enterprise() {
  return <Navigate href="/" />
}
