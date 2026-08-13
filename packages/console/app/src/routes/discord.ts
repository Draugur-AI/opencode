// Disabled (TKT-396 item 6, Ethan's ruling): redirected into upstream's own Discord server. No
// fork Discord exists, and inventing one is not this PR's call -- same footing as the #41
// precedent for config.mjs's discord field.
export async function GET() {
  return new Response(null, { status: 404 })
}
