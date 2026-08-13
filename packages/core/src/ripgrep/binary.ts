import path from "path"
import { Context, Effect, Layer, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "../cross-spawn-spawner"
import { makeGlobalNode } from "../effect/app-node"
import { httpClient } from "../effect/app-node-platform"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { which } from "../util/which"

export namespace RipgrepBinary {
  const VERSION = "15.1.0"

  /**
   * Acquisition stages are bounded separately so a hang names the step it hung
   * in. Without these a stalled download and a shell that never exits are
   * indistinguishable from each other -- both surface only as the caller's
   * generic timeout. Budgets are generous enough for a slow link; they exist to
   * turn a hang into a diagnosis, not to police throughput.
   */
  const DOWNLOAD_TIMEOUT = "60 seconds"
  const EXTRACT_TIMEOUT = "30 seconds"

  const describe = (cause: unknown) =>
    cause instanceof globalThis.Error ? cause.message : typeof cause === "string" ? cause : JSON.stringify(cause)

  const PLATFORM = {
    "arm64-darwin": { platform: "aarch64-apple-darwin", extension: "tar.gz" },
    "arm64-linux": { platform: "aarch64-unknown-linux-gnu", extension: "tar.gz" },
    "x64-darwin": { platform: "x86_64-apple-darwin", extension: "tar.gz" },
    "x64-linux": { platform: "x86_64-unknown-linux-musl", extension: "tar.gz" },
    "arm64-win32": { platform: "aarch64-pc-windows-msvc", extension: "zip" },
    "ia32-win32": { platform: "i686-pc-windows-msvc", extension: "zip" },
    "x64-win32": { platform: "x86_64-pc-windows-msvc", extension: "zip" },
  } as const

  interface Interface {
    readonly filepath: Effect.Effect<string, Error>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/RipgrepBinary") {}

  const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
      const spawner = yield* ChildProcessSpawner

      const run = Effect.fnUntraced(function* (command: string, args: string[]) {
        const handle = yield* spawner.spawn(ChildProcess.make(command, args, { extendEnv: true, stdin: "ignore" }))
        const [stdout, stderr, code] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(handle.stdout)),
            Stream.mkString(Stream.decodeText(handle.stderr)),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        )
        return { stdout, stderr, code }
      }, Effect.scoped)

      const extract = Effect.fnUntraced(function* (
        archive: string,
        config: (typeof PLATFORM)[keyof typeof PLATFORM],
        target: string,
      ) {
        const dir = yield* fs.makeTempDirectoryScoped({ directory: Global.Path.bin, prefix: "ripgrep-" })

        const bounded = (command: string, args: string[]) =>
          run(command, args).pipe(
            Effect.timeoutOrElse({
              duration: EXTRACT_TIMEOUT,
              orElse: () =>
                Effect.die(
                  new Error(`ripgrep extraction timed out after ${EXTRACT_TIMEOUT} running ${command} on ${archive}`),
                ),
            }),
          )

        if (config.extension === "zip") {
          const shell = (yield* Effect.sync(() => which("powershell.exe") ?? which("pwsh.exe"))) ?? "powershell.exe"
          const result = yield* bounded(shell, [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `$global:ProgressPreference = 'SilentlyContinue'; Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${dir.replaceAll("'", "''")}' -Force`,
          ])
          if (result.code !== 0)
            throw new Error(
              `ripgrep extraction failed (${shell}, code ${result.code}): ${result.stderr.trim() || result.stdout.trim() || "no output"}`,
            )
        }

        if (config.extension === "tar.gz") {
          const result = yield* bounded("tar", ["-xzf", archive, "-C", dir])
          if (result.code !== 0)
            throw new Error(
              `ripgrep extraction failed (tar, code ${result.code}): ${result.stderr.trim() || result.stdout.trim() || "no output"}`,
            )
        }

        const extracted = path.join(
          dir,
          `ripgrep-${VERSION}-${config.platform}`,
          process.platform === "win32" ? "rg.exe" : "rg",
        )
        if (!(yield* fs.isFile(extracted))) throw new Error(`ripgrep archive did not contain executable: ${extracted}`)

        yield* fs.copyFile(extracted, target)
        if (process.platform !== "win32") yield* fs.chmod(target, 0o755)
      }, Effect.scoped)

      return Service.of({
        filepath: yield* Effect.cached(
          Effect.gen(function* () {
            const system = yield* Effect.sync(() => which(process.platform === "win32" ? "rg.exe" : "rg"))
            if (system && (yield* fs.isFile(system).pipe(Effect.orDie))) return system

            const target = path.join(Global.Path.bin, `rg${process.platform === "win32" ? ".exe" : ""}`)
            if (yield* fs.isFile(target).pipe(Effect.orDie)) return target

            const platformKey = `${process.arch}-${process.platform}` as keyof typeof PLATFORM
            const config = PLATFORM[platformKey]
            if (!config) throw new Error(`unsupported platform for ripgrep: ${platformKey}`)

            const filename = `ripgrep-${VERSION}-${config.platform}.${config.extension}`
            const url = `https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}/${filename}`
            const archive = path.join(Global.Path.bin, filename)

            yield* Effect.logInfo("downloading ripgrep", { url })
            yield* fs.ensureDir(Global.Path.bin).pipe(Effect.orDie)
            const bytes = yield* HttpClientRequest.get(url).pipe(
              http.execute,
              Effect.flatMap((response) => response.arrayBuffer),
              Effect.mapError((cause) => new Error(`ripgrep download failed from ${url}: ${describe(cause)}`)),
              Effect.timeoutOrElse({
                duration: DOWNLOAD_TIMEOUT,
                orElse: () =>
                  Effect.fail(new Error(`ripgrep download timed out after ${DOWNLOAD_TIMEOUT} from ${url}`)),
              }),
            )
            if (bytes.byteLength === 0) throw new Error(`ripgrep download returned an empty body from ${url}`)

            yield* fs.writeWithDirs(archive, new Uint8Array(bytes))
            yield* extract(archive, config, target)
            yield* fs.remove(archive, { force: true }).pipe(Effect.ignore)
            return target
          }),
        ),
      })
    }),
  )

  export const node = makeGlobalNode({
    service: Service,
    layer: layer,
    deps: [FSUtil.node, httpClient, CrossSpawnSpawner.node],
  })
}
