export * as CompactionEpoch from "./compaction-epoch"

import { DateTime, Effect } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"

/**
 * Injects one durable compaction epoch (Started + Ended) directly, without driving a real turn
 * or LLM call. This is the WORKHORSE for most fixtures -- fast, deterministic, and exercises the
 * same SessionContextEpoch.prepare() replacement logic every real compaction does. It bypasses
 * the actual size-trigger and summarizer call, though, so it is labeled a deterministic
 * approximation everywhere its results are reported (report.ts) -- the anchor fixture
 * (compaction-anchor.test.ts) is what validates this approximation is honest.
 */
export const inject = Effect.fn("CompactionEpoch.inject")(function* (input: {
  readonly sessionID: SessionV2.ID
  readonly summary: string
  readonly recent?: string
  readonly sourceSeqStart?: number
  readonly sourceSeqEnd?: number
}) {
  const events = yield* EventV2.Service
  const messageID = SessionMessage.ID.create()
  const startedAt = yield* DateTime.now
  yield* events.publish(SessionEvent.Compaction.Started, {
    sessionID: input.sessionID,
    messageID,
    timestamp: startedAt,
    reason: "manual",
  })
  const endedAt = yield* DateTime.now
  const recent = input.recent ?? ""
  yield* events.publish(SessionEvent.Compaction.Ended, {
    sessionID: input.sessionID,
    messageID,
    timestamp: endedAt,
    reason: "manual",
    text: input.summary,
    recent,
    tokensBefore: 0,
    retainedTailMessages: 0,
    retainedTailTokens: 0,
    summaryBytes: Buffer.byteLength(input.summary, "utf8"),
    summaryTokens: Math.round(input.summary.length / 4),
    durationMs: 0,
    sourceSeqStart: input.sourceSeqStart ?? 0,
    sourceSeqEnd: input.sourceSeqEnd ?? 0,
  })
  return messageID
})
