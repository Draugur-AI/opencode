import type { APIEvent } from "@solidjs/start/server"

// Disabled (TKT-396 item 6, Ethan's ruling -- item 4's exact subject, a genuine scope-miss in its
// original naming of only docs/s/stats): this forwarded every method, header, and body verbatim to
// https://enterprise.opencode.ai/*, an upstream service this fork has no relationship to. Not just
// unattributed content like the docs/changelog cases -- a live proxy silently forwarding requests
// (and their bodies) off this fork's own domain to a service upstream operates.
function disabled(_evt: APIEvent) {
  return new Response(null, { status: 404 })
}

export const GET = disabled
export const POST = disabled
export const PUT = disabled
export const DELETE = disabled
export const OPTIONS = disabled
export const PATCH = disabled
