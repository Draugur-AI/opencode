export * as BaselineGraph from "./baseline-graph"

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { BaselineBinary } from "./baseline-binary"
import { BaselineServer } from "./baseline-server"
import { FakeHttpLLM } from "./fake-http-llm"

/** Pinned pre-slice-4 baseline sha (TKT-319 PR2 ruling) -- see FORK.md's divergence ledger for
 * why this exact commit, not "upstream", is the comparison point: it is the fork's own dev
 * right before the goal/ledger/history_search slice landed, with lifecycle and durable-intent
 * already in place. */
export const BASELINE_SHA = "87e2771432e85f0a5f8644d1aa924da0bedb0f28"

/** Same shrink-the-model trick as EvalGraph.compactModel (graph.ts), applied through config
 * instead of an in-process Model override -- there is no in-process hook into a real subprocess,
 * so the only lever is the provider config the baseline binary reads on startup. */
const PROVIDER_ID = "test"
const MODEL_ID = "test-model"
export const modelString = `${PROVIDER_ID}/${MODEL_ID}`

export interface Handle {
  readonly baseUrl: string
  readonly llm: {
    readonly requests: ReadonlyArray<{ readonly body: unknown }>
    readonly push: (text: string) => void
  }
  readonly createSession: () => Promise<string>
  readonly sendMessage: (sessionID: string, text: string) => Promise<unknown>
  readonly getMessages: (sessionID: string) => Promise<unknown>
  readonly hasCompacted: (sessionID: string) => Promise<boolean>
  readonly stop: () => Promise<void>
}

/** The HTTP-driving methods are identical regardless of what is behind `providerID`/`modelID` --
 * a fake local server (`build`) or a real LiteLLM gateway (`buildReal`) -- factored out once
 * real-model wiring gave this a second call site. */
const httpHandle = (input: {
  readonly server: { readonly baseUrl: string; readonly stop: () => Promise<void> }
  readonly providerID: string
  readonly modelID: string
  readonly directory: string
  readonly onStop: () => void
}): Omit<Handle, "llm" | "baseUrl"> & { readonly baseUrl: string } => {
  const { server } = input

  const createSession = async (): Promise<string> => {
    const res = await fetch(`${server.baseUrl}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    if (!res.ok) throw new Error(`BaselineGraph: session create failed (${res.status})`)
    const session = (await res.json()) as { id: string }
    return session.id
  }

  const sendMessage = async (sessionID: string, text: string): Promise<unknown> => {
    const res = await fetch(`${server.baseUrl}/session/${sessionID}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerID: input.providerID, modelID: input.modelID, parts: [{ type: "text", text }] }),
    })
    if (!res.ok) throw new Error(`BaselineGraph: message send failed (${res.status}): ${await res.text()}`)
    return res.json()
  }

  const getMessages = async (sessionID: string): Promise<unknown> => {
    const res = await fetch(`${server.baseUrl}/session/${sessionID}/message`)
    if (!res.ok) throw new Error(`BaselineGraph: message list failed (${res.status})`)
    return res.json()
  }

  const hasCompacted = async (sessionID: string): Promise<boolean> => {
    const messages = (await getMessages(sessionID)) as ReadonlyArray<{ parts?: ReadonlyArray<{ type: string }> }>
    return messages.some((m) => (m.parts ?? []).some((p) => p.type === "compaction"))
  }

  return {
    baseUrl: server.baseUrl,
    createSession,
    sendMessage,
    getMessages,
    hasCompacted,
    stop: async () => {
      await server.stop()
      input.onStop()
      fs.rmSync(input.directory, { recursive: true, force: true })
    },
  }
}

/**
 * Sends large filler turns (an empty-string scripted reply each time -- the content of these
 * turns is never asserted on, only their bulk) until the baseline's own real SessionCompaction
 * overflow check fires, or `maxTurns` is exhausted. This is what makes Mode A prove the real
 * compaction pipeline actually ran, not a synthetic stand-in for it (see CompactionEpoch.inject
 * in the current arm, which this deliberately does NOT have an equivalent of -- there is no
 * in-process hook into a real subprocess to inject a summary through).
 */
export const driveUntilCompaction = async (
  handle: Handle,
  sessionID: string,
  input: { readonly maxTurns?: number; readonly fillerRepeat?: number } = {},
): Promise<{ readonly compacted: boolean; readonly turns: number }> => {
  const maxTurns = input.maxTurns ?? 15
  // Sized empirically against this baseline's real overflow.ts (context 20_000, ~200-token
  // reserved buffer from the small compact model): 6 fillers x ~750 tokens each reliably trips
  // it within maxTurns without needing a fixture to grow its own transcript by hand. A real-model
  // caller passes a bigger `fillerRepeat` and a smaller graph context (see buildReal) instead --
  // each real turn costs real wall-clock (~15-20s observed against qwen3-6), so fewer, bigger
  // turns matter there in a way it never did for the scripted arm's local fake server.
  const filler = "x ".repeat(input.fillerRepeat ?? 3_000)
  for (let turn = 0; turn < maxTurns; turn++) {
    handle.llm.push("")
    await handle.sendMessage(sessionID, `filler turn ${turn}: ${filler}`)
    if (await handle.hasCompacted(sessionID)) return { compacted: true, turns: turn + 1 }
  }
  return { compacted: false, turns: maxTurns }
}

/**
 * Starts the real baseline binary as a subprocess plus its fake HTTP LLM, wires the provider
 * config between them, and returns a small HTTP-driving handle -- the baseline-arm equivalent of
 * EvalGraph.build, but there is no Effect layer to provide since nothing here runs in-process.
 */
export const build = async (input: { readonly repoRoot: string }): Promise<Handle> => {
  const binaryPath = await BaselineBinary.ensure(BASELINE_SHA, input.repoRoot)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-eval-baseline-graph-"))
  const llm = FakeHttpLLM.start()

  fs.writeFileSync(
    path.join(directory, "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: modelString,
      provider: {
        [PROVIDER_ID]: {
          name: "Test",
          npm: "@ai-sdk/openai-compatible",
          models: {
            [MODEL_ID]: {
              name: "Test Model",
              // Small enough that a normal-length fixture conversation trips the baseline's own
              // real SessionCompaction overflow check on its own -- see graph.ts's compactModel
              // for why the trigger/summarizer-budget gap has to stay wide (20k/200, not 4k/500).
              limit: { context: 20_000, output: 200 },
              cost: { input: 0, output: 0 },
            },
          },
          options: { apiKey: "test-key", baseURL: llm.baseUrl },
        },
      },
    }),
  )

  const server = await BaselineServer.start({ binaryPath, directory })

  return {
    llm,
    ...httpHandle({ server, providerID: PROVIDER_ID, modelID: MODEL_ID, directory, onStop: () => llm.stop() }),
  }
}

/** Real qwen3-6 provider id/model id -- distinct from `PROVIDER_ID`/`MODEL_ID` above (those
 * name FakeHttpLLM's fake provider) so a request log or config dump is unambiguous about which
 * arm/mode produced it. */
const REAL_PROVIDER_ID = "litellm"
const REAL_MODEL_ID = "qwen3-6"

/**
 * The real-model equivalent of `build` -- same real subprocess binary, no FakeHttpLLM at all.
 * The provider config points directly at the real LiteLLM gateway (`baseURL`, default the
 * `litellm ensure_tunnel` address -- see graph.ts's `realModel` for why qwen3-6:8356 itself only
 * resolves in-cluster). `llm.requests`/`llm.push` are a no-op stub: there is nothing to script or
 * capture wire-level here, matching the current arm's `buildReal` having no `FakeLLM.Instance`.
 */
export const buildReal = async (input: {
  readonly repoRoot: string
  readonly baseURL?: string
}): Promise<Handle> => {
  const baseURL = input.baseURL ?? process.env.EVAL_LITELLM_BASE_URL ?? "http://127.0.0.1:4000/v1"
  const binaryPath = await BaselineBinary.ensure(BASELINE_SHA, input.repoRoot)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-eval-baseline-real-graph-"))

  fs.writeFileSync(
    path.join(directory, "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: `${REAL_PROVIDER_ID}/${REAL_MODEL_ID}`,
      provider: {
        [REAL_PROVIDER_ID]: {
          name: "LiteLLM",
          npm: "@ai-sdk/openai-compatible",
          models: {
            [REAL_MODEL_ID]: {
              name: "qwen3-6",
              // Much smaller than the scripted arm's 20_000: each real turn costs real
              // wall-clock (~15-20s observed against qwen3-6), so this needs to trip
              // overflow.ts's real trigger (usable = context - min(20_000, output)) within a
              // few turns, not the 15-turn budget that is cheap for a local fake server but
              // expensive for a real gateway. Paired with driveUntilCompaction's larger
              // `fillerRepeat` for real-mode callers.
              limit: { context: 8_000, output: 1_000 },
              cost: { input: 0, output: 0 },
            },
          },
          options: { apiKey: "unused", baseURL },
        },
      },
    }),
  )

  const server = await BaselineServer.start({ binaryPath, directory, timeoutMs: 30_000 })

  return {
    llm: { requests: [], push: () => {} },
    ...httpHandle({ server, providerID: REAL_PROVIDER_ID, modelID: REAL_MODEL_ID, directory, onStop: () => {} }),
  }
}
