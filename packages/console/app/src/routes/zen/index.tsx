import { Navigate } from "@solidjs/router"

// Hidden (TKT-396): offering upstream's paid model-credit product to users of a fork running on
// its own inference is an upsell we don't want, not a retarget candidate. The zen API itself
// (v1/*, go/*, util/*) is untouched -- a live, functional system, not marketing copy -- this
// removes only the promotional landing page and its nav entry points.
export default function ZenLanding() {
  return <Navigate href="/" />
}
