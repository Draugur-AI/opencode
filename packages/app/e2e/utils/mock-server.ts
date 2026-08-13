import type { Page, Route } from "@playwright/test"

const emptyList = new Set(["/skill", "/command", "/lsp", "/formatter", "/vcs/status", "/vcs/diff"])
const emptyObject = new Set(["/global/config", "/config", "/provider/auth", "/mcp", "/experimental/resource"])

/** Mirrors `packages/core/src/session/lifecycle.ts`'s `TRANSITIONS` table exactly -- a mock that
 * accepts an illegal transition would let a state-gate journey pass against behavior the real
 * server rejects. `purged` is absent for the same reason it is absent there: it removes the row. */
const LIFECYCLE_TRANSITIONS: Record<string, readonly string[]> = {
  active: ["archived", "trash"],
  archived: ["active", "trash"],
  trash: ["active", "archived"],
}

/** `packages/core/src/session/lifecycle.ts`'s `TrashGraceMillis`. */
const TRASH_GRACE_MILLIS = 30 * 24 * 60 * 60 * 1000

type LifecycleValue =
  | { state: "active" }
  | { state: "archived"; at: number }
  | { state: "trash"; at: number; purgeAfter: number }

const lifecycleOf = (session: Record<string, unknown>): LifecycleValue =>
  (session.lifecycle as LifecycleValue | undefined) ?? { state: "active" }

const revisionOf = (session: Record<string, unknown>): number =>
  typeof session.lifecycleRevision === "number" ? session.lifecycleRevision : 0

export interface MockServerConfig {
  protocol?: "v1" | "v2"
  provider: unknown | (() => unknown)
  integrationMethods?: Record<string, unknown[]>
  onConnectKey?: (input: { integrationID: string; body: unknown }) => void
  onInstanceDispose?: () => void
  directory: string
  project: unknown
  sessions: ({ id: string } & Record<string, unknown>)[]
  pageMessages: (sessionId: string, limit: number, before?: string) => { items: unknown[]; cursor?: string }
  vcsDiff?: unknown[]
  messageDelay?: number
  beforeMessagesResponse?: (input: { sessionID: string; before?: string }) => Promise<void>
  onMessages?: (input: { sessionID: string; before?: string; phase: "start" | "end" }) => void
  message?: (sessionID: string, messageID: string) => unknown
  onMessage?: (input: { sessionID: string; messageID: string }) => void
  events?: () => unknown[]
  eventRetry?: number
  todos?: (sessionID: string) => unknown[]
  permissions?: unknown[] | (() => unknown[])
  questions?: unknown[] | (() => unknown[])
  fileList?: (path: string) => unknown | Promise<unknown>
  fileContent?: (path: string) => unknown | Promise<unknown>
  findFiles?: (input: { query: string; dirs?: string; limit?: number }) => unknown
  sessionStatus?: Record<string, unknown> | (() => Record<string, unknown>)
}

export async function mockOpenCodeServer(page: Page, config: MockServerConfig) {
  const cursors = new Map<string, string>()
  let nextCursor = 0
  const preferences = new Map<string, { projectID: string; favorite: boolean; hidden: boolean; revision: number }>()
  const preferenceFor = (projectID: string) =>
    preferences.get(projectID) ?? { projectID, favorite: false, hidden: false, revision: 0 }
  const staticRoutes: Record<string, unknown> = {
    "/path": {
      state: config.directory,
      config: config.directory,
      worktree: config.directory,
      directory: config.directory,
      home: "C:/OpenCode",
    },
    "/project": [config.project],
    "/project/current": config.project,
    "/agent": [{ name: "build", mode: "primary" }],
    "/vcs": { branch: "main", default_branch: "main" },
    "/session": config.sessions,
  }

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    const targetPort = process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"
    const appPort = new URL(
      process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? "3000"}`,
    ).port
    if (url.port !== targetPort && url.port !== appPort) return route.fallback()

    const path = url.pathname
    if (path === "/global/event" || path === "/event" || path === "/api/event") {
      const events = config.events?.()
      return sse(
        route,
        path === "/api/event"
          ? [{ id: "evt_mock_connected", type: "server.connected", data: {} }, ...(events?.map(currentEvent) ?? [])]
          : [
              ...(path === "/global/event"
                ? [{ payload: { id: "evt_mock_connected", type: "server.connected", properties: {} } }]
                : []),
              ...(events ?? []),
            ],
        config.eventRetry,
      )
    }
    if (path === "/global/health")
      return config.protocol === "v2" ? json(route, {}, undefined, 404) : json(route, { healthy: true })
    if (path === "/api/health" && config.protocol === "v2")
      return json(route, { healthy: true, version: "2.0.0", pid: 1 })
    if (path === "/experimental/capabilities") return json(route, { backgroundSubagents: true })
    if (path === "/provider")
      return json(route, typeof config.provider === "function" ? config.provider() : config.provider)
    if (path === "/provider/auth") return json(route, config.integrationMethods ?? {})
    const legacyAuth = path.match(/^\/auth\/([^/]+)$/)?.[1]
    if (legacyAuth && route.request().method() === "PUT") {
      config.onConnectKey?.({ integrationID: legacyAuth, body: route.request().postDataJSON() })
      return json(route, true)
    }
    if (path === "/instance/dispose" && route.request().method() === "POST") {
      config.onInstanceDispose?.()
      return json(route, true)
    }
    if (path === "/permission")
      return json(route, typeof config.permissions === "function" ? config.permissions() : (config.permissions ?? []))
    if (path === "/question")
      return json(route, typeof config.questions === "function" ? config.questions() : (config.questions ?? []))
    if (path === "/session/status")
      return json(
        route,
        typeof config.sessionStatus === "function" ? config.sessionStatus() : (config.sessionStatus ?? {}),
      )
    if (path === "/vcs/diff" && config.vcsDiff) return json(route, config.vcsDiff)
    if (path === "/file" && config.fileList)
      return json(route, await config.fileList(url.searchParams.get("path") ?? ""))
    if (path === "/file/content" && config.fileContent)
      return json(route, await config.fileContent(url.searchParams.get("path") ?? ""))
    if (path === "/find/file" && config.findFiles)
      return json(
        route,
        await config.findFiles({
          query: url.searchParams.get("query") ?? "",
          dirs: url.searchParams.get("dirs") ?? undefined,
          limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
        }),
      )
    if (path === "/api/reference")
      return json(route, {
        location: {
          directory: config.directory,
          project: { id: (config.project as { id?: string }).id, directory: config.directory },
        },
        data: [],
      })
    if (path === "/api/agent")
      return json(route, {
        location: location(config),
        data: [
          {
            id: "build",
            name: "Build",
            mode: "primary",
            hidden: false,
            request: { settings: {}, headers: {}, body: {} },
            permissions: [],
          },
        ],
      })
    if (path === "/api/command") return json(route, { location: location(config), data: [] })
    if (path === "/api/mcp") return json(route, { location: location(config), data: [] })
    if (path === "/api/mcp/resource")
      return json(route, { location: location(config), data: { resources: [], templates: [] } })
    const integration = path.match(/^\/api\/integration\/([^/]+)$/)?.[1]
    if (integration && route.request().method() === "GET")
      return json(route, {
        location: location(config),
        data: { id: integration, name: integration, methods: [{ type: "key", label: "API key" }], connections: [] },
      })
    const integrationConnect = path.match(/^\/api\/integration\/([^/]+)\/connect\/key$/)?.[1]
    if (integrationConnect && route.request().method() === "POST") {
      config.onConnectKey?.({ integrationID: integrationConnect, body: route.request().postDataJSON() })
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } })
    }
    if (path === "/api/project") return json(route, { data: [config.project] })
    if (path === "/api/project/current")
      return json(route, { id: (config.project as { id?: string }).id, directory: config.directory })
    const preferenceMatch = path.match(/^\/api\/project\/([^/]+)\/preference$/)
    if (preferenceMatch) {
      const projectID = preferenceMatch[1]
      if (route.request().method() === "GET") return json(route, { data: preferenceFor(projectID) })
      if (route.request().method() === "PATCH") {
        const current = preferenceFor(projectID)
        const patch = route.request().postDataJSON() as Partial<typeof current> & { expectedRevision?: number }
        const next = { ...current, ...patch, revision: current.revision + 1 }
        preferences.set(projectID, next)
        return json(route, { data: next })
      }
    }
    if (path.startsWith("/api/project/") && route.request().method() === "PATCH") return json(route, config.project)
    if (path === "/api/path")
      return json(route, {
        state: config.directory,
        config: config.directory,
        worktree: config.directory,
        directory: config.directory,
        home: "C:/OpenCode",
      })
    if (path === "/api/permission/request")
      return json(route, {
        location: location(config),
        data: (typeof config.permissions === "function" ? config.permissions() : (config.permissions ?? [])).map(
          currentPermission,
        ),
      })
    if (path === "/api/question/request")
      return json(route, {
        location: location(config),
        data: typeof config.questions === "function" ? config.questions() : (config.questions ?? []),
      })
    if (path === "/api/vcs")
      return json(route, { location: location(config), data: { branch: "main", defaultBranch: "main" } })
    if (path === "/api/vcs/status") return json(route, { location: location(config), data: [] })
    if (path === "/api/vcs/diff") return json(route, { location: location(config), data: config.vcsDiff ?? [] })
    // `sdk.client.pty.shells()` is the V1 (bare, no `/api` prefix) endpoint -- there is no
    // `/api/pty/shells` in the API at all (checked packages/sdk/openapi.json). An unmatched
    // path here used to fall through to the generic port-based fallback below, which returns a
    // bare `{}` -- a real object, not an array, and not caught by `?? []` guards downstream
    // (TKT-411): every spec that opens the settings-v2 General tab got a malformed response for
    // this endpoint, not a slow or racy one. The body itself is a bare array too, unlike most
    // endpoints here -- checked against packages/sdk/openapi.json's own response schema for
    // `pty.shells`, which is `{type: "array", items: {...}}`, no `{location, data}` envelope.
    if (path === "/pty/shells") return json(route, [])
    if (/^\/api\/pty\/[^/]+\/connect-token$/.test(path))
      return json(route, { location: location(config), data: { ticket: "e2e-ticket", expires_in: 60 } })
    if (emptyObject.has(path)) return json(route, {})
    if (emptyList.has(path)) return json(route, [])
    if (path === "/api/session") {
      const directory = url.searchParams.get("directory")
      const parentID = url.searchParams.get("parentID")
      const limit = Number(url.searchParams.get("limit") ?? 50)
      const offset = Number(url.searchParams.get("cursor") ?? 0)
      // `lifecycle` cursor param (packages/protocol/src/groups/session.ts, `SessionsCursor`):
      // "active" is also the default when the caller omits it, matching `session.list`'s server
      // behavior of not surfacing archived/trashed rows unless asked for.
      const lifecycle = url.searchParams.get("lifecycle") ?? "active"
      const sessions = config.sessions
        .filter((session) => !directory || session.directory === directory)
        .filter((session) => parentID !== "null" || session.parentID === undefined)
        .filter((session) => lifecycle === "all" || lifecycleOf(session).state === lifecycle)
        .filter((session) => {
          const search = url.searchParams.get("search")?.toLowerCase()
          return (
            !search ||
            String(session.title ?? "")
              .toLowerCase()
              .includes(search)
          )
        })
      const ordered = url.searchParams.get("order") === "asc" ? sessions.toReversed() : sessions
      const data = ordered.slice(offset, offset + limit)
      const next = offset + limit < ordered.length ? String(offset + limit) : undefined
      return json(route, {
        data: data.map((session) => currentSession(session, config.directory)),
        cursor: { next },
      })
    }
    if (path === "/api/session/active") {
      const statuses = (config.sessionStatus ?? {}) as Record<string, { type?: string }>
      return json(route, {
        data: Object.fromEntries(
          Object.entries(statuses).flatMap(([id, status]) =>
            status.type === "idle" ? [] : [[id, { type: "running" }]],
          ),
        ),
      })
    }
    if (/^\/api\/session\/[^/]+\/shell$/.test(path) && route.request().method() === "POST") {
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } })
    }
    if (/^\/api\/session\/[^/]+\/question\/[^/]+\/(reply|reject)$/.test(path) && route.request().method() === "POST") {
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } })
    }
    if (/^\/api\/session\/[^/]+\/permission\/[^/]+\/reply$/.test(path) && route.request().method() === "POST") {
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } })
    }
    if (/^\/question\/[^/]+\/(reply|reject)$/.test(path) && route.request().method() === "POST") {
      return json(route, true)
    }
    if (/^\/session\/[^/]+\/permissions\/[^/]+$/.test(path) && route.request().method() === "POST") {
      return json(route, true)
    }
    if (
      /^\/api\/session\/[^/]+\/(rename|interrupt|revert\/clear|revert\/commit)$/.test(path) &&
      route.request().method() === "POST"
    ) {
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } })
    }
    if (/^\/api\/session\/[^/]+$/.test(path) && route.request().method() === "DELETE") {
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } })
    }

    // The four reversible lifecycle verbs -- named for the handler comment that groups them the
    // same way (packages/server/src/handlers/session.ts's `lifecycle()` wrapper).
    const lifecycleMutationMatch = path.match(/^\/api\/session\/([^/]+)\/(archive|restore|trash|restore-from-trash)$/)
    if (lifecycleMutationMatch && route.request().method() === "POST") {
      const sessionID = lifecycleMutationMatch[1]!
      const verb = lifecycleMutationMatch[2]!
      const session = config.sessions.find((item) => item.id === sessionID)
      if (!session) return json(route, { sessionID, message: `Session not found: ${sessionID}` }, undefined, 404)

      const to = verb === "trash" ? "trash" : verb === "archive" ? "archived" : "active"
      const from = lifecycleOf(session).state
      const revision = revisionOf(session)
      const body = (route.request().postDataJSON() ?? {}) as {
        requestID?: string
        expectedLifecycleRevision?: number
      }

      // packages/core/src/session/lifecycle.ts `project()`'s compare-and-set: a caller-supplied
      // revision that no longer matches the row loses to SessionLifecycleConflictError (409),
      // carrying the revision the row actually holds rather than overwriting past it.
      if (body.expectedLifecycleRevision !== undefined && body.expectedLifecycleRevision !== revision) {
        return json(
          route,
          { sessionID, lifecycleRevision: revision, message: `Session lifecycle moved to revision ${revision}` },
          undefined,
          409,
        )
      }

      // packages/core/src/session/lifecycle.ts `TRANSITIONS`: SessionLifecycleTransitionError (409).
      if (!LIFECYCLE_TRANSITIONS[from]?.includes(to)) {
        return json(route, { sessionID, from, to, message: `Session cannot move from ${from} to ${to}` }, undefined, 409)
      }

      const now = Date.now()
      session.lifecycle =
        to === "active"
          ? { state: "active" }
          : to === "archived"
            ? { state: "archived", at: now }
            : { state: "trash", at: now, purgeAfter: now + TRASH_GRACE_MILLIS }
      session.lifecycleRevision = revision + 1
      // packages/core/src/session/lifecycle.ts `toRow()`: `time_archived` is the V1-compatibility
      // mirror of "is archived", set exactly on entry to `archived` and cleared on every other
      // transition -- a stale `time.archived` here would fool `server-session.ts`'s V1-shaped
      // `session.updated` listener (reads `info.time.archived`) into treating a restored or
      // trashed session as still archived.
      const previousTime = session.time as Record<string, unknown> | undefined
      session.time = { ...previousTime, updated: now, archived: to === "archived" ? now : undefined }
      return json(route, { data: currentSession(session, config.directory) })
    }

    const purgeMatch = path.match(/^\/api\/session\/([^/]+)\/purge$/)
    if (purgeMatch && route.request().method() === "POST") {
      const sessionID = purgeMatch[1]!
      const index = config.sessions.findIndex((item) => item.id === sessionID)
      if (index === -1) return json(route, { sessionID, message: `Session not found: ${sessionID}` }, undefined, 404)
      const session = config.sessions[index]!
      const body = (route.request().postDataJSON() ?? {}) as { requestID?: string; confirmation?: string }
      // packages/server/src/handlers/session.ts purge handler: the confirmation must echo the
      // session ID back, or InvalidRequestError (400) -- this is what stops a fat-fingered call
      // from destroying the wrong session.
      if (body.confirmation !== sessionID) {
        return json(
          route,
          {
            message: "Permanent deletion requires the session ID echoed back as confirmation.",
            field: "confirmation",
            kind: sessionID,
          },
          undefined,
          400,
        )
      }
      const revision = revisionOf(session)
      config.sessions.splice(index, 1)
      // packages/schema/src/session-lifecycle.ts `Tombstone` / generated `SessionsPurgeOutput` --
      // no transcript content, just enough for a client to tell "purged" apart from "not fetched
      // yet" for the retention window.
      return json(route, {
        data: {
          id: sessionID,
          projectID: (session.projectID as string | undefined) ?? "project",
          purgedAt: Date.now(),
          lastLifecycleRevision: revision,
        },
      })
    }
    if (path in staticRoutes) return json(route, staticRoutes[path])

    const currentSessionMatch = path.match(/^\/api\/session\/([^/]+)$/)
    if (currentSessionMatch) {
      const session = config.sessions.find((item) => item.id === currentSessionMatch[1])
      if (!session) return json(route, { error: "Session not found" }, undefined, 404)
      return json(route, {
        data: currentSession(session, config.directory),
      })
    }

    const sessionMatch = path.match(/^\/session\/([^/]+)$/)
    if (sessionMatch) {
      const session = config.sessions.find((s) => s.id === sessionMatch[1])
      return json(route, session ?? {})
    }

    const projectMatch = path.match(/^\/project\/([^/]+)$/)
    if (projectMatch) return json(route, config.project)

    const messageMatch = path.match(/^\/session\/([^/]+)\/message\/([^/]+)$/)
    if (messageMatch) {
      config.onMessage?.({ sessionID: messageMatch[1]!, messageID: messageMatch[2]! })
      if (config.messageDelay !== undefined) await new Promise((resolve) => setTimeout(resolve, config.messageDelay))
      const message = config.message?.(messageMatch[1]!, messageMatch[2]!)
      if (message === undefined) return json(route, { error: "Message not found" }, undefined, 404)
      return json(route, message)
    }

    const todoMatch = path.match(/^\/session\/([^/]+)\/todo$/)
    if (todoMatch) return json(route, config.todos?.(todoMatch[1]!) ?? [])
    if (/^\/session\/[^/]+\/(children|diff)$/.test(path)) return json(route, [])

    const currentMessagesMatch = path.match(/^\/api\/session\/([^/]+)\/message$/)
    if (currentMessagesMatch) {
      const token = url.searchParams.get("cursor") ?? undefined
      const before = token ? cursors.get(token) : undefined
      if (token && !before) return json(route, { error: "Invalid cursor" }, undefined, 400)
      config.onMessages?.({ sessionID: currentMessagesMatch[1], before, phase: "start" })
      await config.beforeMessagesResponse?.({ sessionID: currentMessagesMatch[1]!, before })
      if (config.messageDelay !== undefined) await new Promise((resolve) => setTimeout(resolve, config.messageDelay))
      const pageData = config.pageMessages(currentMessagesMatch[1], Number(url.searchParams.get("limit") ?? 50), before)
      config.onMessages?.({ sessionID: currentMessagesMatch[1], before, phase: "end" })
      const cursor = pageData.cursor ? `cursor_${++nextCursor}` : undefined
      if (cursor) cursors.set(cursor, pageData.cursor!)
      return json(route, {
        data: pageData.items.map(currentMessage).reverse(),
        cursor: { next: cursor },
      })
    }

    const messagesMatch = path.match(/^\/session\/([^/]+)\/message$/)
    if (messagesMatch) {
      const token = url.searchParams.get("before") ?? undefined
      const before = token ? cursors.get(token) : undefined
      if (token && !before) return json(route, { error: "Invalid cursor" }, undefined, 400)
      config.onMessages?.({ sessionID: messagesMatch[1], before, phase: "start" })
      await config.beforeMessagesResponse?.({ sessionID: messagesMatch[1]!, before })
      if (config.messageDelay !== undefined) await new Promise((resolve) => setTimeout(resolve, config.messageDelay))
      const limit = Number(url.searchParams.get("limit") ?? 80)
      const pageData = config.pageMessages(messagesMatch[1], limit, before)
      config.onMessages?.({ sessionID: messagesMatch[1], before, phase: "end" })
      if (!pageData.cursor) return json(route, pageData.items)
      const cursor = `cursor_${++nextCursor}`
      cursors.set(cursor, pageData.cursor)
      return json(route, pageData.items, { "x-next-cursor": cursor })
    }

    if (url.port === targetPort && targetPort !== appPort) return json(route, {})
    return route.fallback()
  })
}

function location(config: MockServerConfig) {
  return {
    directory: config.directory,
    project: { id: (config.project as { id?: string }).id, directory: config.directory },
  }
}

function currentPermission(value: unknown) {
  const permission = value as Record<string, unknown>
  if (permission.action) return permission
  const tool = permission.tool as { messageID?: string; callID?: string } | undefined
  return {
    id: permission.id,
    sessionID: permission.sessionID,
    action: permission.permission,
    resources: permission.patterns ?? [],
    save: permission.always,
    metadata: permission.metadata,
    source:
      tool?.messageID && tool.callID ? { type: "tool", messageID: tool.messageID, callID: tool.callID } : undefined,
  }
}

export function currentSession(session: { id: string } & Record<string, unknown>, fallbackDirectory?: string) {
  const time = session.time && typeof session.time === "object" ? session.time : {}
  return {
    id: session.id,
    parentID: session.parentID,
    projectID: session.projectID ?? "project",
    agent: session.agent ?? "build",
    model: session.model ?? { id: "mock-model", providerID: "mock-provider" },
    cost: session.cost ?? 0,
    tokens: session.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: {
      created: "created" in time && typeof time.created === "number" ? time.created : 0,
      updated: "updated" in time && typeof time.updated === "number" ? time.updated : 0,
      ...(session.time && typeof session.time === "object" && "archived" in session.time
        ? { archived: session.time.archived }
        : {}),
    },
    // `Session.Info.lifecycle`/`lifecycleRevision` (packages/schema/src/session-lifecycle.ts) --
    // absent on a config-authored session means "never mutated", same as a fresh row there.
    lifecycle: lifecycleOf(session),
    lifecycleRevision: revisionOf(session),
    title: session.title ?? session.id,
    location: {
      directory: typeof session.directory === "string" ? session.directory : fallbackDirectory,
      ...(typeof session.workspaceID === "string" ? { workspaceID: session.workspaceID } : {}),
    },
    subpath: session.path,
    revert: session.revert,
  }
}

function currentMessage(value: unknown) {
  const item = value as {
    info: Record<string, unknown> & { id: string; role: "user" | "assistant"; time: { created: number } }
    parts: Array<Record<string, unknown> & { type: string }>
  }
  if (item.info.role === "user") {
    return {
      id: item.info.id,
      type: "user",
      time: item.info.time,
      text: item.parts
        .flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
        .join("\n"),
    }
  }
  return {
    id: item.info.id,
    type: "assistant",
    time: item.info.time,
    agent: item.info.agent ?? "build",
    model: { id: item.info.modelID ?? "model", providerID: item.info.providerID ?? "provider" },
    cost: item.info.cost,
    tokens: item.info.tokens,
    error: item.info.error,
    content: item.parts.flatMap<unknown>((part) => {
      if (part.type === "text" || part.type === "reasoning") return [{ type: part.type, text: part.text ?? "" }]
      if (part.type !== "tool") return []
      const state = part.state as Record<string, unknown>
      return [
        {
          type: "tool",
          id: part.id,
          name: part.tool,
          time: state.time ?? { created: item.info.time.created },
          state:
            state.status === "pending"
              ? { status: "streaming", input: state.raw ?? JSON.stringify(state.input ?? {}) }
              : state.status === "completed"
                ? {
                    status: "completed",
                    input: state.input ?? {},
                    structured: state.metadata ?? {},
                    content: [{ type: "text", text: state.output ?? "" }],
                  }
                : state.status === "error"
                  ? {
                      status: "error",
                      input: state.input ?? {},
                      structured: state.metadata ?? {},
                      content: [],
                      error: { type: "ToolError", message: state.error ?? "Tool failed" },
                    }
                  : { status: "running", input: state.input ?? {}, structured: state.metadata ?? {}, content: [] },
        },
      ]
    }),
  }
}

function json(route: Route, body: unknown, headers?: Record<string, string>, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "x-next-cursor",
      ...headers,
    },
    body: JSON.stringify(body ?? null),
  })
}

function sse(route: Route, events?: unknown[], retry?: number) {
  return route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: `${retry === undefined ? "" : `retry: ${retry}\n\n`}${events?.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") || ": ok\n\n"}`,
  })
}

function currentEvent(input: unknown) {
  if (!input || typeof input !== "object" || !("payload" in input)) return input
  const envelope = input as { directory?: string; payload?: unknown }
  if (!envelope.payload || typeof envelope.payload !== "object") return input
  const payload = envelope.payload as { id?: string; type?: string; properties?: unknown }
  if (!payload.type) return input
  return {
    id: payload.id ?? `evt_mock_${Date.now()}`,
    created: Date.now(),
    type: payload.type,
    data: payload.properties ?? {},
    location: envelope.directory && envelope.directory !== "global" ? { directory: envelope.directory } : undefined,
  }
}
