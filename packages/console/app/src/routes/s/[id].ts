import type { APIEvent } from "@solidjs/start/server"

// Disabled (TKT-396): previously proxied to docs.opencode.ai, an upstream service. No route in
// this console links here (share-link-style short URLs, reached only by direct/external URL).
async function handler(_evt: APIEvent) {
  return new Response(null, { status: 404 })
}

export const GET = handler
export const POST = handler
export const PUT = handler
export const DELETE = handler
export const OPTIONS = handler
export const PATCH = handler
