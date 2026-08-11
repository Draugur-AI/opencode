export * as FakeHttpLLM from "./fake-http-llm"

/**
 * A minimal OpenAI-compatible streaming chat-completions server, for the baseline arm -- the
 * historical binary runs as a real subprocess (baseline-server.ts), so unlike the current arm
 * (an in-process FakeLLM.Instance substituted via an Effect layer) there is no in-process hook
 * to script. The baseline binary's own config points its provider at this server's URL instead,
 * the same "point a real HTTP client at a local fake" shape
 * packages/opencode/test/lib/llm-server.ts uses for the in-repo httpapi-exercise tests (not
 * reusable here directly -- it is Effect/HttpRouter-based and lives in another package's test
 * dir, not exported across the workspace).
 *
 * Deliberately minimal: text-only streaming responses, no tool-call framing, no request
 * matching by content. The baseline is pre-slice-4 and has no tools this eval drives it through
 * anyway (no history_search, no goal/ledger tools) -- scoring against it is plain-text outcome
 * comparison (see PR2's design note: "does the baseline complete the task, does it re-ask for
 * information already given").
 */
export interface Instance {
  readonly baseUrl: string
  readonly requests: Array<{ readonly body: unknown }>
  readonly push: (text: string) => void
  readonly stop: () => void
}

const sseChunk = (input: { readonly delta?: Record<string, unknown>; readonly finish?: string }) =>
  `data: ${JSON.stringify({
    id: "fake-http-llm",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: input.delta ?? {}, finish_reason: input.finish ?? null }],
  })}\n\n`

/**
 * A new V1 session auto-generates its own title on the first turn -- a SEPARATE completions
 * call the harness did not ask for and must not let consume a scripted response meant for the
 * real turn (matches packages/opencode/test/lib/llm-server.ts's own isTitleRequest, generalized
 * past its exact string match since the baseline sha's title prompt wording differs from
 * current dev's -- "title generator" is the stable marker across both).
 */
const isTitleRequest = (body: unknown) => JSON.stringify(body).toLowerCase().includes("title generator")

export const start = (): Instance => {
  const queue: string[] = []
  const requests: Array<{ readonly body: unknown }> = []

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url)
      if (url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 })

      const body = await request.json().catch(() => ({}))
      const isTitle = isTitleRequest(body)
      if (!isTitle) requests.push({ body })
      const text = isTitle ? "Fake title" : (queue.shift() ?? "")

      const stream = new ReadableStream({
        start: (controller) => {
          const encoder = new TextEncoder()
          controller.enqueue(encoder.encode(sseChunk({ delta: { role: "assistant" } })))
          if (text) controller.enqueue(encoder.encode(sseChunk({ delta: { content: text } })))
          controller.enqueue(encoder.encode(sseChunk({ finish: "stop" })))
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
        },
      })

      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    },
  })

  return {
    // Includes /v1 -- @ai-sdk/openai-compatible appends /chat/completions directly to
    // whatever `options.baseURL` a provider config gives it, so the caller must not have to
    // remember to add /v1 itself (a config pointed at the bare origin 404s at the SDK layer,
    // not at this server, which is confusing to debug from the config-writer's side).
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    requests,
    push: (text) => queue.push(text),
    stop: () => server.stop(true),
  }
}
