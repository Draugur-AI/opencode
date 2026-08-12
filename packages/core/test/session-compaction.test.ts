import { expect, test } from "bun:test"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"

test("compaction prompt preserves detailed work state and relevant files", () => {
  const prompt = SessionCompaction.buildPrompt({ context: ["conversation history"] })

  expect(prompt).toContain("## Work State\n### Completed")
  expect(prompt).toContain("### Active")
  expect(prompt).toContain("### Blocked")
  expect(prompt).toContain("## Relevant Files")
})

test("exceedsCapacity applies the estimator safety factor -- a request the raw estimate clears still exceeds capacity once inflated by 1.2x (TKT-377, diary 2584/2594: char/4 under-counts structured tool output by up to 31%)", () => {
  // context=100000, buffer=1000 -> usable capacity is 99000. rawEstimate=90000 clears that
  // raw (90000 <= 99000), but 90000 * 1.2 = 108000 exceeds it -- exactly the gap the live
  // measurements found between the estimate and the model's own reported prompt_tokens.
  const input = { rawEstimate: 90_000, context: 100_000, output: 0, buffer: 1_000 }
  expect(SessionCompaction.exceedsCapacity(input)).toBe(true)
  // Delete-the-fix check: without the factor (raw comparison only), this same input would NOT
  // have triggered -- 90000 <= 99000.
  expect(input.rawEstimate <= input.context - Math.max(input.output, input.buffer)).toBe(true)
})

test("exceedsCapacity still returns false comfortably under capacity, factor included", () => {
  const input = { rawEstimate: 10_000, context: 100_000, output: 0, buffer: 1_000 }
  expect(SessionCompaction.exceedsCapacity(input)).toBe(false)
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
