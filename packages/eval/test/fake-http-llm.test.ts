import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { BaselineBinary } from "../src/baseline-binary"
import { BaselineServer } from "../src/baseline-server"
import { FakeHttpLLM } from "../src/fake-http-llm"

const BASELINE_SHA = "87e2771432e85f0a5f8644d1aa924da0bedb0f28"

const writeFakeLlmConfig = (directory: string, url: string) => {
  fs.writeFileSync(
    path.join(directory, "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "test/test-model",
      provider: {
        test: {
          name: "Test",
          npm: "@ai-sdk/openai-compatible",
          models: {
            "test-model": {
              name: "Test Model",
              limit: { context: 100000, output: 10000 },
              cost: { input: 0, output: 0 },
            },
          },
          options: { apiKey: "test-key", baseURL: url },
        },
      },
    }),
  )
}

describe("FakeHttpLLM + BaselineServer", () => {
  test("the baseline binary streams a real reply from the fake HTTP LLM", async () => {
    const repoRoot = (await $`git rev-parse --show-toplevel`.cwd(import.meta.dir).quiet().text()).trim()
    const binary = await BaselineBinary.ensure(BASELINE_SHA, repoRoot)
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-eval-baseline-llm-"))

    const llm = FakeHttpLLM.start()
    writeFakeLlmConfig(directory, llm.baseUrl)

    const server = await BaselineServer.start({ binaryPath: binary, directory })
    try {
      llm.push("Hello from the baseline arm.")

      const created = await fetch(`${server.baseUrl}/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
      const session = (await created.json()) as { id: string }

      const sent = await fetch(`${server.baseUrl}/session/${session.id}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerID: "test",
          modelID: "test-model",
          parts: [{ type: "text", text: "Hi" }],
        }),
      })
      expect(sent.ok).toBe(true)
      const reply = (await sent.json()) as { parts?: Array<{ type: string; text?: string }> }
      const text = (reply.parts ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("")
      expect(text).toContain("Hello from the baseline arm")
      expect(llm.requests.length).toBeGreaterThan(0)
    } finally {
      await server.stop()
      llm.stop()
    }
  }, 60_000)
})
