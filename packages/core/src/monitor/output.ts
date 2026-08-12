export * as MonitorOutput from "./output"

import path from "path"
import { createHash } from "crypto"
import { Context, Effect, Layer, Schema } from "effect"
import type { Monitor } from "@opencode-ai/schema/monitor"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { makeGlobalNode } from "../effect/app-node"
import { Identifier } from "../util/identifier"

const DEFAULT_MAX_LINES = 200
const DEFAULT_MAX_BYTES = 8 * 1024
const MANAGED_DIRECTORY = "monitor-output"
const REDACTED = "[REDACTED]"

export interface Bound {
  readonly preview: string
  readonly checksum: string
  readonly bytes: number
  readonly objectRef?: string
}

export class StorageError extends Schema.TaggedErrorClass<StorageError>()("MonitorOutput.StorageError", {
  cause: Schema.Defect(),
}) {}

// Applied before anything is persisted, on the RAW captured text -- the stored tail preview and
// the managed-storage object are both redacted, never just the rendered view (diary 2435 §3).
// Invalid patterns are skipped rather than failing the check: a monitor's own condition/output
// still needs to evaluate even if one redactPattern is malformed.
export const redact = (text: string, patterns: ReadonlyArray<string> | undefined) => {
  if (!patterns || patterns.length === 0) return text
  return patterns.reduce((current, pattern) => {
    try {
      return current.replace(new RegExp(pattern, "g"), REDACTED)
    } catch {
      return current
    }
  }, text)
}

const tail = (text: string, maxLines: number, maxBytes: number) => {
  const lines = text.split("\n").slice(-maxLines).join("\n")
  let bytes = 0
  const chars: string[] = []
  for (const char of Array.from(lines).toReversed()) {
    const size = Buffer.byteLength(char, "utf-8")
    if (bytes + size > maxBytes) break
    chars.unshift(char)
    bytes += size
  }
  return chars.join("")
}

export interface Interface {
  /**
   * Redacts, then bounds the redacted text to a tail preview, and -- only when the redacted text
   * exceeds the preview bounds -- writes the FULL redacted text to managed storage and returns a
   * reference to it. checksum/bytes are always computed over the (redacted) full text, whether or
   * not it was written, so a caller can tell a truncated preview apart from the complete output.
   */
  readonly bound: (input: {
    readonly text: string
    readonly policy: Monitor.OutputPolicy
  }) => Effect.Effect<Bound, StorageError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/MonitorOutput") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const directory = path.join(global.data, MANAGED_DIRECTORY)

    const write = Effect.fn("MonitorOutput.write")(function* (content: string) {
      const file = path.join(directory, `check_${Identifier.ascending()}`)
      yield* fs.ensureDir(directory).pipe(Effect.mapError((cause) => new StorageError({ cause })))
      yield* fs.writeFileString(file, content, { flag: "wx" }).pipe(Effect.mapError((cause) => new StorageError({ cause })))
      return file
    })

    const bound: Interface["bound"] = Effect.fn("MonitorOutput.bound")(function* (input) {
      const clean = redact(input.text, input.policy.redactPatterns)
      const bytes = Buffer.byteLength(clean, "utf-8")
      const checksum = createHash("sha256").update(clean, "utf-8").digest("hex")
      const maxLines = input.policy.maxLines ?? DEFAULT_MAX_LINES
      const maxBytes = input.policy.maxBytes ?? DEFAULT_MAX_BYTES
      const preview = tail(clean, maxLines, maxBytes)
      const truncated = preview.length < clean.length
      const objectRef = truncated ? yield* write(clean) : undefined
      return { preview, checksum, bytes, objectRef }
    })

    return Service.of({ bound })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [FSUtil.node, Global.node] })
