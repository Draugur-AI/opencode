export * as BaselineServer from "./baseline-server"

import { type Subprocess, spawn } from "bun"
import net from "node:net"

export interface Handle {
  readonly baseUrl: string
  readonly stop: () => Promise<void>
}

/** An OS-assigned free TCP port, released immediately for the subprocess to bind. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port)
        else reject(new Error("BaselineServer: could not determine a free port"))
      })
    })
    server.on("error", reject)
  })

const waitForReady = async (baseUrl: string, subprocess: Subprocess, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (subprocess.exitCode !== null) {
      throw new Error(`BaselineServer: process exited (code ${subprocess.exitCode}) before becoming ready`)
    }
    try {
      // A single attempt's connection can be accepted at the OS level while the process itself
      // is too CPU-starved (under a heavy concurrent test suite) to respond for a long time --
      // without a per-attempt timeout, one hung fetch() blocks this whole loop past `deadline`,
      // since the deadline is only re-checked BETWEEN iterations, never inside an awaited call.
      const response = await fetch(`${baseUrl}/global/health`, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
    } catch {
      // not listening yet, or this attempt timed out -- either way, retry until the deadline
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`BaselineServer: not ready after ${timeoutMs}ms`)
}

/**
 * Starts the historical binary as a real subprocess exposing the real headless HTTP server --
 * this is what makes the baseline arm a genuinely different runtime, driven the same way a real
 * client would (real HTTP), not an in-process Effect graph like the current arm.
 */
export const start = async (input: {
  readonly binaryPath: string
  readonly directory: string
  readonly timeoutMs?: number
}): Promise<Handle> => {
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`

  const subprocess = spawn({
    cmd: [input.binaryPath, "serve", "--port", String(port), "--hostname", "127.0.0.1"],
    cwd: input.directory,
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env },
  })

  try {
    // A cold OS page-cache (the compiled binary is ~180MB) can push first-start well past a
    // warm one -- observed once, ~15s+ cold vs ~0.7s once the bytes are cached. 30s default.
    await waitForReady(baseUrl, subprocess, input.timeoutMs ?? 30_000)
  } catch (error) {
    subprocess.kill()
    throw error
  }

  return {
    baseUrl,
    stop: async () => {
      subprocess.kill()
      await subprocess.exited
    },
  }
}
