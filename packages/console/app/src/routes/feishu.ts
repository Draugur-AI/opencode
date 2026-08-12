// Disabled (TKT-396 item 6, Ethan's ruling): redirected into an upstream-specific Feishu group.
// Same footing as discord.ts -- no fork equivalent exists, and inventing one is not this PR's call.
export async function GET() {
  return new Response(null, { status: 404 })
}
