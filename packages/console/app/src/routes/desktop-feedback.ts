import { redirect } from "@solidjs/router"

// Retargeted (TKT-396 item 6, Ethan's ruling): not a hide -- this is decision 1's already-approved
// bug destination (factual, issues enabled there). The desktop app's feedback path should land on
// the fork's own issue tracker, not upstream's Discord.
export async function GET() {
  return redirect("https://github.com/Draugur-AI/opencode/issues")
}
