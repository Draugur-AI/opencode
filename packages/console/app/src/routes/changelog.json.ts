// Hidden (TKT-396 item 6, Ethan's ruling): same reasoning as routes/changelog/index.tsx -- this
// served github.com/anomalyco/opencode's own releases as this fork's changelog feed. Restore once
// the fork publishes its own releases and lib/changelog.ts has something real to point at.
export async function GET() {
  return new Response(null, { status: 404 })
}
