import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { BaselineBinary } from "../src/baseline-binary"
import { BaselineServer } from "../src/baseline-server"

const BASELINE_SHA = "87e2771432e85f0a5f8644d1aa924da0bedb0f28"

describe("BaselineServer.start", () => {
  test("boots the historical binary as a real HTTP server and serves a real session create", async () => {
    const repoRoot = (await $`git rev-parse --show-toplevel`.cwd(import.meta.dir).quiet().text()).trim()
    const binary = await BaselineBinary.ensure(BASELINE_SHA, repoRoot)
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-eval-baseline-project-"))

    const server = await BaselineServer.start({ binaryPath: binary, directory })
    try {
      const health = await fetch(`${server.baseUrl}/global/health`)
      expect(health.ok).toBe(true)

      const created = await fetch(`${server.baseUrl}/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
      expect(created.ok).toBe(true)
      const session = (await created.json()) as { id: string }
      expect(typeof session.id).toBe("string")
    } finally {
      await server.stop()
    }
  }, 60_000)
})
