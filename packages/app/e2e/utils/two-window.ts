import type { Browser, Page } from "@playwright/test"
import { mockOpenCodeServer, type MockServerConfig } from "./mock-server"
import { installSseTransport, type SseTransport } from "./sse-transport"

export type WindowHandle<T> = { page: Page; transport: SseTransport<T> }

const DEFAULT_SERVER = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

/**
 * A second (or third) Playwright window pointed at the SAME mock backend. `mock-server.ts` is not
 * a real server -- `mockOpenCodeServer` is a per-page `page.route` closure over `config` -- so
 * "shared backend" here means both windows' closures read and write the same `config` object.
 * `config.sessions` must be one genuinely mutable array (the lifecycle POST handlers in
 * mock-server.ts push/splice it in place): a mutation applied through window A's route handler is
 * visible to window B's route handler on its very next read, exactly because it is the same array.
 *
 * There is no server-side fan-out to simulate that sharing: each window still opens its OWN SSE
 * connection and needs its OWN `.send()` call to observe a "live" event -- the test plays the part
 * of the server pushing to each connected client.
 */
export async function openWindow<T>(
  browser: Browser,
  config: MockServerConfig,
  options: { server?: string; eventRetry?: number } = {},
): Promise<WindowHandle<T>> {
  const server = options.server ?? DEFAULT_SERVER
  const context = await browser.newContext()
  const page = await context.newPage()
  const transport = await installSseTransport<T>(page, { server, retry: options.eventRetry ?? 20 })
  await mockOpenCodeServer(page, config)
  return { page, transport }
}
