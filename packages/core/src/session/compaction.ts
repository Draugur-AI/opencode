export * as SessionCompaction from "./compaction"

import { LLM, LLMError, LLMEvent, Message, type LLMRequest, type Model } from "@opencode-ai/llm"
import { DateTime, Effect, Stream } from "effect"
import type { Config } from "../config"
import type { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { Token } from "../util/token"
import { BaselineCounters } from "../observability/baseline-counters"

const DEFAULT_BUFFER = 20_000
const DEFAULT_KEEP_TOKENS = 8_000
// TKT-377, diary 2584/2594: Token.estimate's char/4 heuristic under-counts structured tool output
// (measured ratios against live usage.prompt_tokens: git log 0.69, JSON tool output 0.73, file
// listings 0.86; realistic agent request 0.88) -- the exact content mix a long agentic session is
// dominated by.
//
// The anchor redesign (diary 2584 §5, this comment updated when it landed) scopes this factor to
// ONLY the delta-estimate portion of exceedsCapacity's input -- the anchored portion is real
// usage.prompt_tokens from the last assistant turn, never estimated, so it never needed inflating.
// REMOVAL CONDITION: once there is live evidence that a delta-only estimate (typically a handful
// of new messages since the last real measurement, not a whole conversation) doesn't need this
// margin -- e.g. a repeat of diary 2584's live-measurement methodology run against delta-sized
// samples specifically -- this can drop to 1.0. Do not remove on reasoning alone; re-measure.
const ESTIMATOR_SAFETY_FACTOR = 1.2
const TOOL_OUTPUT_MAX_CHARS = 2_000
const SUMMARY_OUTPUT_TOKENS = 4_096
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Write the sections themselves as plain facts and state, not as narration about how this summary
  was produced -- do not write things like "this session was summarized" inside the sections above.
  This is about the summary's own prose only: the surrounding transcript already marks this as a
  compaction checkpoint and names how to retrieve anything not included here (to-llm-message.ts's
  "compaction" case), and that marker must stay -- TKT-379, diary 2610: hiding it drops
  history_search's call rate from 100% to 20% because the model receives no cue that older detail
  might exist at all.`

export type Entry = {
  readonly seq: number
  readonly message: SessionMessage.Message
}

type Settings = {
  readonly auto: boolean
  readonly buffer: number
  readonly tokens: number
}

type Dependencies = {
  readonly events: EventV2.Interface
  readonly llm: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
  readonly config: readonly Config.Entry[]
}

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly entries: readonly Entry[]
  readonly model: Model
  readonly request: LLMRequest
}

const estimate = (value: unknown) => Token.estimate(JSON.stringify(value))

// Pure so the safety-factor boundary is testable without a live model or LLM request -- TKT-377.
// `anchoredTokens` is real usage.prompt_tokens (from a real assistant turn) and is never inflated;
// `estimatedTokens` is char/4-derived and is the only part the safety factor applies to. The
// no-anchor fallback (findAnchor below) calls this with anchoredTokens=0 and the full
// char-count estimate in estimatedTokens -- identical to the pre-anchor behavior.
export const exceedsCapacity = (input: {
  readonly anchoredTokens: number
  readonly estimatedTokens: number
  readonly context: number
  readonly output: number
  readonly buffer: number
}) =>
  input.anchoredTokens + input.estimatedTokens * ESTIMATOR_SAFETY_FACTOR >
  input.context - Math.max(input.output, input.buffer)

const truncate = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`

export const serializeToolContent = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content
    .map((item) =>
      item.type === "text" ? item.text : `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
    )
    .join("\n")

// Exported for reuse by history-search.ts: both compaction and full-history search need the same
// "message -> normalized plain text" rendering, and duplicating it would let the two drift apart.
export const serialize = (message: SessionMessage.Message) => {
  if (message.type === "user") {
    const files = message.files?.map((file) => `[Attached ${file.mime}: ${file.name ?? file.uri}]`) ?? []
    return [`[User]: ${message.text}`, ...files].join("\n")
  }
  if (message.type === "assistant") {
    return message.content
      .flatMap((part) => {
        if (part.type === "text") return [`[Assistant]: ${part.text}`]
        if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
        const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
        if (part.state.status === "completed")
          return [
            `[Assistant tool call]: ${part.name}(${input})`,
            `[Tool result]: ${truncate(serializeToolContent(part.state.content))}`,
          ]
        if (part.state.status === "error")
          return [`[Assistant tool call]: ${part.name}(${input})`, `[Tool error]: ${part.state.error.message}`]
        return [`[Assistant tool call]: ${part.name}(${input})`]
      })
      .join("\n")
  }
  if (message.type === "system") return `[System update]: ${message.text}`
  if (message.type === "synthetic") return `[Synthetic context]: ${message.text}`
  if (message.type === "shell") return `[Shell]: ${message.command}\n${truncate(message.output)}`
  return ""
}

// TKT-377, diary 2584 §5: the most recent assistant message with recorded usage carries the REAL
// prompt-token count for that turn (message.tokens.input, exactly what the provider reported
// usage.prompt_tokens as) plus its own real response size (message.tokens.output) -- together,
// the real total context size as of right after that turn completed. Everything appended to
// `entries` since then (a new user message, this turn's own tool results so far) is the only part
// that still needs char-count estimation, and it is normally small relative to a whole
// conversation. Assumes system/tools are unchanged since the anchor turn (the common case for one
// agent loop); does not re-estimate them, so a mid-session profile/tool-list change between the
// anchor and now is not separately accounted for -- diary 2584's measured error was in structured
// tool OUTPUT content, not schema size, so this is the right thing to leave unestimated rather
// than the right thing to chase.
const findAnchor = (entries: readonly Entry[]) => {
  for (let index = entries.length - 1; index >= 0; index--) {
    const message = entries[index]!.message
    if (message.type === "assistant" && message.tokens !== undefined)
      return { realTokens: message.tokens.input + message.tokens.output, afterIndex: index }
  }
  return undefined
}

// Exported for direct testing -- TKT-377.
export const anchoredEstimate = (entries: readonly Entry[]) => {
  const anchor = findAnchor(entries)
  if (!anchor) return undefined
  const delta = entries.slice(anchor.afterIndex + 1)
  return {
    anchoredTokens: anchor.realTokens,
    estimatedTokens: delta.reduce((total, entry) => total + Token.estimate(serialize(entry.message)), 0),
  }
}

const settings = (documents: readonly Config.Entry[]) => {
  const configured = documents
    .filter((entry): entry is Config.Document => entry.type === "document")
    .flatMap((entry) => (entry.info.compaction ? [entry.info.compaction] : []))
  return configured.reduce<Settings>(
    (result, current) => ({
      auto: current.auto ?? result.auto,
      buffer: current.buffer ?? result.buffer,
      tokens: current.keep?.tokens ?? result.tokens,
    }),
    { auto: true, buffer: DEFAULT_BUFFER, tokens: DEFAULT_KEEP_TOKENS },
  )
}

const select = (
  entries: readonly Entry[],
  tokens: number,
): { readonly head: string; readonly recent: string; readonly retainedCount: number } | undefined => {
  const conversation = entries
    .filter((entry) => entry.message.type !== "compaction")
    .map((entry) => serialize(entry.message))
    .filter(Boolean)
  if (conversation.length === 0) return
  let total = 0
  let split = conversation.length
  let splitPrefix = ""
  let splitSuffix = ""
  for (let index = conversation.length - 1; index >= 0; index--) {
    const next = total + Token.estimate(conversation[index])
    if (next > tokens) {
      const remaining = Math.max(0, tokens - total) * 4
      if (remaining > 0) {
        splitPrefix = conversation[index].slice(0, -remaining)
        splitSuffix = conversation[index].slice(-remaining)
        split = index + 1
      }
      break
    }
    total = next
    split = index
  }
  return {
    head: [...conversation.slice(0, split), splitPrefix].filter(Boolean).join("\n\n"),
    recent: [splitSuffix, ...conversation.slice(split)].filter(Boolean).join("\n\n"),
    // Whole messages retained into the tail. A message straddling the split point (splitSuffix
    // non-empty) is counted here too -- it is retained, just partially.
    retainedCount: conversation.length - split,
  }
}

export const buildPrompt = (input: { readonly previousSummary?: string; readonly context: readonly string[] }) =>
  [
    input.previousSummary
      ? `Update the anchored summary below using the conversation history above.\nPreserve still-true details, remove stale details, and merge in the new facts.\n<previous-summary>\n${input.previousSummary}\n</previous-summary>`
      : "Create a new anchored summary from the conversation history.",
    SUMMARY_TEMPLATE,
    ...input.context,
  ].join("\n\n")

export const make = (dependencies: Dependencies) => {
  const config = settings(dependencies.config)
  const compactAfterOverflow = Effect.fn("SessionCompaction.compactAfterOverflow")(function* (input: Input) {
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    const selected = select(input.entries, config.tokens)
    const previousSummary = input.entries.find((entry) => entry.message.type === "compaction")?.message
    if (!selected || (selected.head.length === 0 && previousSummary?.type !== "compaction")) return false
    const summaryPrompt = buildPrompt({
      previousSummary: previousSummary?.type === "compaction" ? previousSummary.summary : undefined,
      context: [previousSummary?.type === "compaction" ? previousSummary.recent : "", selected.head].filter(Boolean),
    })
    const summaryOutput = Math.min(output || SUMMARY_OUTPUT_TOKENS, SUMMARY_OUTPUT_TOKENS)
    if (Token.estimate(summaryPrompt) > context - summaryOutput) return false
    const messageID = SessionMessage.ID.create()
    const tokensBefore = estimate({
      system: input.request.system,
      messages: input.request.messages,
      tools: input.request.tools,
    })
    const startedAt = yield* DateTime.now
    yield* dependencies.events.publish(SessionEvent.Compaction.Started, {
      sessionID: input.sessionID,
      messageID,
      timestamp: startedAt,
      reason: "auto",
    })
    // TKT-309 baseline: how often compaction actually runs (past the size checks above),
    // ahead of the durable-goal/ledger slice that changes what survives it.
    yield* Effect.logInfo("baseline: compaction run", {
      sessionID: input.sessionID,
      total: BaselineCounters.compactionRun(),
    })

    const chunks: string[] = []
    let failed = false
    const summarized = yield* dependencies.llm
      .stream(
        LLM.request({
          model: input.model,
          messages: [Message.user(summaryPrompt)],
          tools: [],
          generation: { maxTokens: summaryOutput },
        }),
      )
      .pipe(
        Stream.runForEach((event) => {
          if (LLMEvent.is.providerError(event)) failed = true
          if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
          return Effect.void
        }),
        Effect.as(true),
        Effect.catchTag("LLM.Error", () => Effect.succeed(false)),
      )
    const summary = chunks.join("")
    if (!summarized || failed || !summary.trim()) return false
    const endedAt = yield* DateTime.now
    const seqs = input.entries.map((entry) => entry.seq)
    yield* dependencies.events.publish(SessionEvent.Compaction.Ended, {
      sessionID: input.sessionID,
      messageID,
      timestamp: endedAt,
      reason: "auto",
      text: summary,
      recent: selected.recent,
      tokensBefore,
      retainedTailMessages: selected.retainedCount,
      retainedTailTokens: Token.estimate(selected.recent),
      summaryBytes: Buffer.byteLength(summary, "utf8"),
      summaryTokens: Token.estimate(summary),
      durationMs: DateTime.toEpochMillis(endedAt) - DateTime.toEpochMillis(startedAt),
      sourceSeqStart: Math.min(...seqs),
      sourceSeqEnd: Math.max(...seqs),
    })
    return true
  })
  const compactIfNeeded = Effect.fn("SessionCompaction.compactIfNeeded")(function* (input: Input) {
    if (!config.auto) return false
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    // No anchor yet (session start, or nothing since the last compaction has a real usage number)
    // falls back to the pre-anchor full char-count estimate, unchanged.
    const { anchoredTokens, estimatedTokens } = anchoredEstimate(input.entries) ?? {
      anchoredTokens: 0,
      estimatedTokens: estimate({ system: input.request.system, messages: input.request.messages, tools: input.request.tools }),
    }
    if (!exceedsCapacity({ anchoredTokens, estimatedTokens, context, output, buffer: config.buffer })) return false
    return yield* compactAfterOverflow(input)
  })
  return {
    compactIfNeeded,
    compactAfterOverflow,
  }
}
