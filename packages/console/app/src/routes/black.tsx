import { Navigate } from "@solidjs/router"

// Hidden (TKT-396 item 6, Ethan's ruling): a fourth live upstream paid-subscription page
// ("OpenCode Black -- access all the world's best coding models"), the same class item 5 already
// approved hiding for Zen. This is the parent layout for the whole /black subtree (this file
// wraps black/index.tsx and black/subscribe/[plan].tsx as `props.children`) -- replacing it with
// a redirect stops both from ever rendering, so neither nested route needs its own change. No nav
// entry pointed here to begin with (verified), so there is nothing else to unlink.
export default function BlackLayout() {
  return <Navigate href="/" />
}
