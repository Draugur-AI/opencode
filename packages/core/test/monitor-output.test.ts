import fs from "fs/promises"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { MonitorOutput } from "@opencode-ai/core/monitor/output"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const withOutput = <A, E, R>(body: (output: MonitorOutput.Interface, root: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const env = AppNodeBuilder.build(LayerNode.group([MonitorOutput.node]), [
        [Global.node, Global.layerWith({ data: tmp.path })],
      ])
      return Effect.gen(function* () {
        return yield* body(yield* MonitorOutput.Service, tmp.path)
      }).pipe(Effect.provide(env))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const it = testEffect(Layer.empty)

describe("MonitorOutput.bound", () => {
  it.live(
    "returns the full text as the preview when it fits within the policy bounds, no managed storage write",
    () =>
      withOutput((output) =>
        Effect.gen(function* () {
          const result = yield* output.bound({ text: "short output", policy: {} })
          expect(result.preview).toBe("short output")
          expect(result.objectRef).toBeUndefined()
          expect(result.bytes).toBe(Buffer.byteLength("short output", "utf-8"))
        }),
      ),
  )

  it.live(
    "truncates to a tail preview and writes the full text to managed storage when it exceeds the bounds",
    () =>
      withOutput((output) =>
        Effect.gen(function* () {
          const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n")
          const result = yield* output.bound({ text: big, policy: { maxLines: 5, maxBytes: 1000 } })
          expect(result.objectRef).toBeDefined()
          expect(result.preview).not.toBe(big)
          expect(result.preview.split("\n").length).toBeLessThanOrEqual(5)
          expect(result.preview).toContain("line 499") // tail preview keeps the END, not the start
          if (result.objectRef) {
            const written = yield* Effect.promise(() => fs.readFile(result.objectRef!, "utf-8"))
            expect(written).toBe(big)
          }
        }),
      ),
  )

  it.live("redacts before computing the preview -- it reflects the redacted text, never the raw one", () =>
    withOutput((output) =>
      Effect.gen(function* () {
        const secret = "token=sk-abc123xyz"
        const result = yield* output.bound({ text: secret, policy: { redactPatterns: ["sk-[a-z0-9]+"] } })
        expect(result.preview).not.toContain("sk-abc123xyz")
        expect(result.preview).toContain("[REDACTED]")
      }),
    ),
  )

  it.live("an invalid redactPattern is skipped rather than failing the whole check", () =>
    withOutput((output) =>
      Effect.gen(function* () {
        const result = yield* output.bound({ text: "hello world", policy: { redactPatterns: ["(unclosed", "world"] } })
        expect(result.preview).toBe("hello [REDACTED]")
      }),
    ),
  )
})
