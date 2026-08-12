import { expect, test } from "bun:test"
import { DateTime } from "effect"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"

const created = DateTime.makeUnsafe(0)
const id = (value: string) => SessionMessage.ID.make(`msg_${value}`)

function user(value: string, text: string): SessionCompaction.Entry["message"] {
  return SessionMessage.User.make({ id: id(value), type: "user", text, time: { created } })
}

function shell(value: string, output: string): SessionCompaction.Entry["message"] {
  return SessionMessage.Shell.make({ id: id(value), type: "shell", callID: value, command: "cmd", output, time: { created } })
}

function assistant(
  value: string,
  content: SessionMessage.Assistant["content"],
  tokens?: SessionMessage.Assistant["tokens"],
): SessionCompaction.Entry["message"] {
  return SessionMessage.Assistant.make({
    id: id(value),
    type: "assistant",
    agent: "build",
    model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
    content,
    tokens,
    time: { created, completed: created },
  })
}

test("compaction prompt preserves detailed work state and relevant files", () => {
  const prompt = SessionCompaction.buildPrompt({ context: ["conversation history"] })

  expect(prompt).toContain("## Work State\n### Completed")
  expect(prompt).toContain("### Active")
  expect(prompt).toContain("### Blocked")
  expect(prompt).toContain("## Relevant Files")
})

test("exceedsCapacity applies the estimator safety factor to the estimated portion -- a request the raw estimate clears still exceeds capacity once inflated by 1.2x (TKT-377, diary 2584/2594: char/4 under-counts structured tool output by up to 31%)", () => {
  // context=100000, buffer=1000 -> usable capacity is 99000. estimatedTokens=90000 clears that
  // raw (90000 <= 99000), but 90000 * 1.2 = 108000 exceeds it -- exactly the gap the live
  // measurements found between the estimate and the model's own reported prompt_tokens. No anchor
  // in this fixture (anchoredTokens=0), matching the pre-anchor fallback shape.
  const input = { anchoredTokens: 0, estimatedTokens: 90_000, context: 100_000, output: 0, buffer: 1_000 }
  expect(SessionCompaction.exceedsCapacity(input)).toBe(true)
  // Delete-the-fix check: without the factor (raw comparison only), this same input would NOT
  // have triggered -- 90000 <= 99000.
  expect(input.anchoredTokens + input.estimatedTokens <= input.context - Math.max(input.output, input.buffer)).toBe(
    true,
  )
})

test("exceedsCapacity still returns false comfortably under capacity, factor included", () => {
  const input = { anchoredTokens: 0, estimatedTokens: 10_000, context: 100_000, output: 0, buffer: 1_000 }
  expect(SessionCompaction.exceedsCapacity(input)).toBe(false)
})

test("exceedsCapacity: the safety factor never touches anchoredTokens -- a real anchor alone can push over capacity with zero estimated delta", () => {
  // TKT-377 anchor redesign: anchoredTokens is real usage.prompt_tokens, never multiplied. If it
  // alone already exceeds capacity, that must trigger regardless of the (here, zero) estimate --
  // proves the factor is scoped to estimatedTokens only, not applied to the whole sum.
  // usable = context - buffer = 100000 - 400 = 99600; anchoredTokens (99700) alone clears that.
  const input = { anchoredTokens: 99_700, estimatedTokens: 0, context: 100_000, output: 0, buffer: 400 }
  expect(SessionCompaction.exceedsCapacity(input)).toBe(true)
})

test("anchoredEstimate: the last assistant turn with recorded tokens becomes the anchor, and only entries AFTER it are estimated", () => {
  const tokens = { input: 50_000, output: 1_000, reasoning: 0, cache: { read: 0, write: 0 } }
  const entries: SessionCompaction.Entry[] = [
    { seq: 1, message: user("u1", "older turn, before the anchor") },
    { seq: 2, message: assistant("a1", [], tokens) }, // the anchor
    { seq: 3, message: user("u2", "new turn since the anchor") },
  ]
  const result = SessionCompaction.anchoredEstimate(entries)
  expect(result).toBeDefined()
  // anchoredTokens = anchor's own input + output (real, from the provider) -- the pre-anchor user
  // turn contributes NOTHING extra: it was already inside the anchor's own real input count.
  expect(result?.anchoredTokens).toBe(51_000)
  // estimatedTokens is derived only from u2 (after the anchor) -- delete-the-fix check: if the
  // slice included the pre-anchor entry too, this would be nonzero for a different reason and the
  // anchoredTokens/estimatedTokens split would double-count u1.
  expect(result?.estimatedTokens).toBeGreaterThan(0)
})

test("anchoredEstimate: no assistant turn with recorded tokens yet -- returns undefined so the caller falls back to a full estimate", () => {
  const entries: SessionCompaction.Entry[] = [
    { seq: 1, message: user("u1", "first turn, nothing has run yet") },
  ]
  expect(SessionCompaction.anchoredEstimate(entries)).toBeUndefined()
})

test("anchoredEstimate: an assistant turn with no tokens recorded (e.g. a compacted/replayed one) is skipped -- the search keeps looking further back", () => {
  const tokens = { input: 20_000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } }
  const entries: SessionCompaction.Entry[] = [
    { seq: 1, message: assistant("real-anchor", [], tokens) },
    { seq: 2, message: user("u1", "between") },
    { seq: 3, message: assistant("no-tokens", []) }, // tokens undefined -- must not become the anchor
  ]
  const result = SessionCompaction.anchoredEstimate(entries)
  expect(result?.anchoredTokens).toBe(20_500)
})

test("anchoredEstimate: cached prompt tokens count toward the real anchor (Copilot review, PR #35) -- cache.read/write still occupy the context window", () => {
  // input+output alone would give 51_000; the real total the provider actually billed against the
  // context window also includes cache.read (5_000) and cache.write (2_000) -- matching the legacy
  // path's own definition of real usage (overflow.ts's isOverflow: input+output+cache.read+cache.write).
  const tokens = { input: 50_000, output: 1_000, reasoning: 999_999, cache: { read: 5_000, write: 2_000 } }
  const entries: SessionCompaction.Entry[] = [{ seq: 1, message: assistant("a1", [], tokens) }]
  const result = SessionCompaction.anchoredEstimate(entries)
  // Delete-the-fix check: input+output alone (51_000) is what the pre-fix code returned --
  // asserting the full 58_000 fails against that old sum.
  expect(result?.anchoredTokens).toBe(58_000)
  // reasoning is deliberately excluded even though it dwarfs everything else in this fixture --
  // it is this turn's own generation, not content resent in a future prompt.
})

test("anchoredEstimate: the delta estimate does not truncate a large post-anchor tool/shell output (Copilot review, PR #35)", () => {
  const tokens = { input: 1_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } }
  const bigOutput = "x".repeat(20_000) // far past TOOL_OUTPUT_MAX_CHARS (2_000) -- serialize() would truncate this
  const entries: SessionCompaction.Entry[] = [
    { seq: 1, message: assistant("anchor", [], tokens) },
    { seq: 2, message: shell("big-shell", bigOutput) },
  ]
  const result = SessionCompaction.anchoredEstimate(entries)
  // 20_000 chars / 4 is ~5_000 tokens; a truncated estimate would cap out far below that (serialize's
  // TOOL_OUTPUT_MAX_CHARS=2_000 -> ~500 tokens plus the "[truncated]" marker and wrapper text).
  expect(result?.estimatedTokens).toBeGreaterThan(4_000)
})

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})
