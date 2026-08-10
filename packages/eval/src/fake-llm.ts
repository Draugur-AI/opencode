export * as FakeLLM from "./fake-llm"

import {
  LLMClient,
  LLMEvent,
  type LLMClientShape,
  type LLMClientService,
  type LLMError,
  type LLMRequest,
} from "@opencode-ai/llm"
import { Layer, Stream } from "effect"

/**
 * A per-instance fake LLMClient.Service, scripted per call. Modeled on the module-level fake
 * client in packages/core/test/session-runner.test.ts, but instantiable multiple times with
 * independent state -- an eval run drives many sessions (fixtures x modes x epochs) and each
 * needs its own captured-request log and its own response queue, not one shared mutable module.
 */
export interface Instance {
  readonly layer: Layer.Layer<LLMClientService>
  /** Every LLMRequest this client has streamed a response for, in call order. */
  readonly requests: LLMRequest[]
  /** Queue one scripted response for the next stream() call. FIFO; each call consumes one entry. */
  readonly push: (events: readonly LLMEvent[]) => void
  /** Clear captured requests without touching the queued script. */
  readonly resetRequests: () => void
}

export const make = (): Instance => {
  const requests: LLMRequest[] = []
  const queue: (readonly LLMEvent[])[] = []

  const layer = Layer.succeed(
    LLMClient.Service,
    LLMClient.Service.of({
      prepare: () => {
        throw new Error("FakeLLM.Instance: prepare() is not scripted")
      },
      stream: ((request: LLMRequest) => {
        requests.push(request)
        return Stream.fromIterable(queue.shift() ?? [])
      }) as unknown as LLMClientShape["stream"],
      generate: () => {
        throw new Error("FakeLLM.Instance: generate() is not scripted")
      },
    }),
  )

  return {
    layer,
    requests,
    push: (events) => queue.push(events),
    resetRequests: () => {
      requests.length = 0
    },
  }
}

/** A single assistant turn that just answers with plain text and stops. */
export const textTurn = (text: string, id = "eval_text"): LLMEvent[] => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id }),
  LLMEvent.textDelta({ id, text }),
  LLMEvent.textEnd({ id }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

/**
 * A single assistant turn that calls one provider-executed tool and stops. The runner loops back
 * for a follow-up model call once the tool result is fed back in -- callers must also push a
 * subsequent response (even an empty `[]`, or another textTurn) for that follow-up.
 */
export const toolCallTurn = (callID: string, name: string, input: unknown): LLMEvent[] => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolCall({ id: callID, name, input }),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
]

export type { LLMError }
