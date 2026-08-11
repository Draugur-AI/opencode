import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import fs from "node:fs"
import { BaselineBinary } from "../src/baseline-binary"

// The sha this fork's TKT-319 baseline is pinned to -- verified first-parent-of-#7 (the
// goal/ledger merge), i.e. dev immediately before slice 4 landed.
const BASELINE_SHA = "87e2771432e85f0a5f8644d1aa924da0bedb0f28"

describe("BaselineBinary.ensure", () => {
  test("builds and caches a real standalone binary at the pinned baseline sha", async () => {
    const repoRoot = (await $`git rev-parse --show-toplevel`.cwd(import.meta.dir).quiet().text()).trim()
    const binary = await BaselineBinary.ensure(BASELINE_SHA, repoRoot)
    expect(fs.existsSync(binary)).toBe(true)

    const version = await $`${binary} --version`.quiet().text()
    expect(version.trim().length).toBeGreaterThan(0)

    // Second call must not rebuild -- same path, no worktree/install/build side effects, fast.
    const started = Date.now()
    const cachedAgain = await BaselineBinary.ensure(BASELINE_SHA, repoRoot)
    expect(cachedAgain).toBe(binary)
    expect(Date.now() - started).toBeLessThan(2_000)
  }, 300_000)
})
