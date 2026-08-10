export * as ContextAccounting from "./context-accounting"

import { Token } from "@opencode-ai/core/util/token"
import type { LLMRequest } from "@opencode-ai/llm"

/**
 * Per-source token/byte accounting for one composed LLMRequest -- the spec's "record context
 * bytes and tokens contributed by goal, ledger, profile, recent tail, and retrieved history"
 * requirement, and the harness's primary defense against "reliability bought by injecting the
 * full transcript" (making history_search results balloon the tail would show up here as a
 * jump in `tail`, not `retrievedHistory`, since a tool result IS part of the message tail).
 *
 * `system` in an LLMRequest is a flat array of parts with no source tags, so attribution here is
 * by TEXT MATCH against durable-state renderers' own delimiters (`<session_goal>`,
 * `<session_ledger>`) rather than by construction -- the harness observes the wire artifact, the
 * same discipline the rest of this fork uses (verify the artifact, not the mechanism that built
 * it). A goal/ledger renderer that changes its wrapper tag needs this updated alongside it; there
 * is no schema-level guarantee tying the two together.
 */
export interface Breakdown {
  readonly goal: { readonly bytes: number; readonly tokens: number }
  readonly ledger: { readonly bytes: number; readonly tokens: number }
  readonly otherSystem: { readonly bytes: number; readonly tokens: number }
  readonly tail: { readonly bytes: number; readonly tokens: number }
  readonly tools: { readonly bytes: number; readonly tokens: number }
  readonly total: { readonly bytes: number; readonly tokens: number }
}

const sizeOf = (text: string) => ({ bytes: Buffer.byteLength(text, "utf8"), tokens: Token.estimate(text) })

const add = (a: { bytes: number; tokens: number }, b: { bytes: number; tokens: number }) => ({
  bytes: a.bytes + b.bytes,
  tokens: a.tokens + b.tokens,
})

export const breakdown = (request: LLMRequest): Breakdown => {
  let goal = { bytes: 0, tokens: 0 }
  let ledger = { bytes: 0, tokens: 0 }
  let otherSystem = { bytes: 0, tokens: 0 }

  for (const part of request.system) {
    const size = sizeOf(part.text)
    if (part.text.includes("<session_goal>")) goal = add(goal, size)
    else if (part.text.includes("<session_ledger>")) ledger = add(ledger, size)
    else otherSystem = add(otherSystem, size)
  }

  const tail = sizeOf(JSON.stringify(request.messages))
  const tools = sizeOf(JSON.stringify(request.tools ?? []))
  const total = [goal, ledger, otherSystem, tail, tools].reduce(add, { bytes: 0, tokens: 0 })

  return { goal, ledger, otherSystem, tail, tools, total }
}
