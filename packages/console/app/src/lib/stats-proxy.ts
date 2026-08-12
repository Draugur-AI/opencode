import type { APIEvent } from "@solidjs/start/server"

// Disabled (TKT-396): previously proxied to stats.opencode.ai, an upstream service, and
// redirected /stats/* to /data/*. Both route trees return 404 now; header.tsx's "/data" nav
// link was removed in the same change.
export async function statsProxy(_evt: APIEvent) {
  return new Response(null, { status: 404 })
}

export function statsRedirect(_evt: APIEvent) {
  return new Response(null, { status: 404 })
}
