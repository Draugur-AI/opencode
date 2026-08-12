import type { APIEvent } from "@solidjs/start/server"

// Hidden (TKT-396 item 6): the form that posted here is gone (routes/enterprise/index.tsx now
// redirects home). Disabled rather than left reachable -- the handler it backed sent every
// submission to contact@anoma.ly (upstream's own inbox), an upstream Salesforce lead, and an
// upstream EmailOctopus list, none of which this fork should be silently routing user data
// through. GET/DELETE also 404 -- there was never a use for anything but POST here.
export async function POST(_evt: APIEvent) {
  return new Response(null, { status: 404 })
}
