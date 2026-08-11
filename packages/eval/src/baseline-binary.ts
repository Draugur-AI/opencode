export * as BaselineBinary from "./baseline-binary"

import { $ } from "bun"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * A standalone `opencode` binary built at an exact historical sha, cached by that sha so a full
 * Mode A gate run (R repeats x N fixtures) builds it once, not once per run. `build.ts --single`
 * is `bun build --compile` under the hood (packages/opencode/script/build.ts) -- this wraps it in
 * a throwaway git worktree so the current checkout's working tree is never touched.
 *
 * Minimal by design (Ethan, TKT-319 PR2 ruling): a directory keyed by sha plus an existence
 * check. No pruning, no LRU, no manifest -- if the cache grows unwieldy that is a `rm -rf` away,
 * not a feature to build ahead of need.
 */

const cacheRoot = () => path.join(os.homedir(), ".cache", "opencode-eval", "baseline")

const platformDir = () => {
  const os_ = process.platform === "win32" ? "windows" : process.platform
  const arch = process.arch
  return `opencode-${os_}-${arch}`
}

/** Absolute path to the cached binary for `sha`, whether or not it has been built yet. */
export const binaryPath = (sha: string) => path.join(cacheRoot(), sha, "bin", "opencode")

/**
 * Builds and caches the binary for `sha` if it is not already cached, then returns its path.
 * Safe to call repeatedly -- an existing cache entry is returned immediately without touching
 * the network or the filesystem beyond the existence check.
 */
export const ensure = async (sha: string, repoRoot: string): Promise<string> => {
  const cached = binaryPath(sha)
  if (fs.existsSync(cached)) return cached

  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-eval-baseline-worktree-"))
  try {
    await $`git worktree add ${worktree} ${sha}`.cwd(repoRoot).quiet()
    await $`bun install`.cwd(worktree).quiet()
    await $`bun run script/build.ts --single --skip-install`.cwd(path.join(worktree, "packages/opencode")).quiet()

    const builtBinary = path.join(worktree, "packages/opencode/dist", platformDir(), "bin/opencode")
    if (!fs.existsSync(builtBinary)) {
      throw new Error(`BaselineBinary.ensure: build.ts --single did not produce ${builtBinary}`)
    }

    fs.mkdirSync(path.dirname(cached), { recursive: true })
    fs.copyFileSync(builtBinary, cached)
    fs.chmodSync(cached, 0o755)
    return cached
  } finally {
    // Best-effort: a leaked worktree directory is a `git worktree prune` away, not worth
    // failing an otherwise-successful build over.
    await $`git worktree remove --force ${worktree}`
      .cwd(repoRoot)
      .quiet()
      .catch(() => fs.rmSync(worktree, { recursive: true, force: true }))
  }
}
