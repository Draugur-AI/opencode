import type { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000

export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const maxOutput = ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax)
  if (input.model.limit.input) {
    const reserved = input.cfg.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, maxOutput)
    return Math.max(0, input.model.limit.input - reserved)
  }
  // TKT-377: isOverflow compares this against the PREVIOUS completed turn's real usage
  // (lastFinished.tokens, prompt.ts) -- by the time the NEXT request actually goes out, a new
  // user message and this turn's own tool results have grown the prompt past what was measured.
  // A reserve of exactly maxOutputTokens (no additional cushion) budgets zero room for that
  // growth. Prod-confirmed (diary 2600): qwen3-6 (context 131072, output 8192, no limit.input
  // configured, so this branch) overflowed at prompt=122,881 -- one token past the un-cushioned
  // trigger of 131072-8192=122880 -- plus the 8192 requested output, exactly 131,073 = window+1.
  // Same max-with-floor shape as the V2 estimator's reserve (session/compaction.ts's
  // Math.max(output, config.buffer)): guarantee at least COMPACTION_BUFFER of headroom for
  // between-turn growth, not just whatever the model's own (possibly much smaller) output cap is.
  // An explicit cfg.compaction.reserved still overrides the floor, same as the other branch.
  const reserved = input.cfg.compaction?.reserved ?? Math.max(maxOutput, COMPACTION_BUFFER)
  return Math.max(0, context - reserved)
}

export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  return count >= usable(input)
}
