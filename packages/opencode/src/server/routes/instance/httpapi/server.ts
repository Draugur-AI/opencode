import { Config as EffectConfig, Context, Effect, Layer } from "effect"
import { HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import { HttpClient, HttpMiddleware, HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as Observability from "@opencode-ai/core/observability"
import { Account } from "@/account/account"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { BackgroundJob } from "@/background/job"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { Workspace } from "@/control-plane/workspace"
import { Env } from "@/env"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { Git } from "@/git"
import { Installation } from "@/installation"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import { Monitor } from "@opencode-ai/core/monitor"
import { MonitorRuntime } from "@opencode-ai/core/monitor/runtime"
import { McpRuntime } from "@opencode-ai/core/config/mcp-runtime"
import { McpRuntimeLive } from "@/mcp/runtime"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { PluginPtyEnvironment } from "@/plugin/pty-environment"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Vcs } from "@/project/vcs"
import { ProviderAuth } from "@/provider/auth"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { SessionCompaction } from "@/session/compaction"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { SessionProcessor } from "@/session/processor"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { SessionShare } from "@/share/session"
import { ShareNext } from "@/share/share-next"
import { Skill } from "@/skill"
import { Discovery } from "@/skill/discovery"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Worktree } from "@/worktree"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilderV1 } from "@/effect/app-node-builder-v1"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Npm } from "@opencode-ai/core/npm"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionGoal } from "@opencode-ai/core/session/goal"
import { SessionLedger } from "@opencode-ai/core/session/ledger"
import { ProjectCopy } from "@opencode-ai/core/project/copy"
import { PtyTicket } from "@opencode-ai/core/pty/ticket"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import * as SessionExecutionLocal from "@opencode-ai/core/session/execution/local"
import { lazy } from "@/util/lazy"
import { CorsConfig, isAllowedCorsOrigin, type CorsOptions } from "@opencode-ai/server/cors"
import { serveUIEffect } from "@/server/shared/ui"
import { serveDocsEffect } from "@/server/shared/docs"
import { ServerAuth } from "@/server/auth"
import { InstanceHttpApi, RootHttpApi } from "./api"
import { Api } from "@opencode-ai/server/api"
import { PublicApi } from "./public"
import {
  authorizationLayer,
  authorizationRouterMiddleware,
  ptyConnectAuthorizationLayer,
  serverAuthorizationLayer,
} from "./middleware/authorization"
import { EventApi } from "./groups/event"
import { PtyConnectApi } from "./groups/pty"
import { eventHandlers } from "./handlers/event"
import { configHandlers } from "./handlers/config"
import { controlHandlers } from "./handlers/control"
import { controlPlaneHandlers } from "./handlers/control-plane"
import { experimentalHandlers } from "./handlers/experimental"
import { fileHandlers } from "./handlers/file"
import { globalHandlers } from "./handlers/global"
import { instanceHandlers } from "./handlers/instance"
import { mcpHandlers } from "./handlers/mcp"
import { permissionHandlers } from "./handlers/permission"
import { projectHandlers } from "./handlers/project"
import { projectCopyHandlers } from "./handlers/project-copy"
import { providerHandlers } from "./handlers/provider"
import { ptyConnectHandlers, ptyHandlers } from "./handlers/pty"
import { questionHandlers } from "./handlers/question"
import { sessionHandlers } from "./handlers/session"
import { syncHandlers } from "./handlers/sync"
import { tuiHandlers } from "./handlers/tui"
import { handlers } from "@opencode-ai/server/handlers"
import { buildLocationServiceMap, LocationServiceMap } from "@opencode-ai/core/location-services"
import { layer as locationLayer } from "@opencode-ai/server/location"
import { sessionLocationLayer } from "@opencode-ai/server/middleware/session-location"
import { PtyEnvironment } from "@opencode-ai/server/pty-environment"
import { schemaErrorLayer as v2SchemaErrorLayer } from "@opencode-ai/server/middleware/schema-error"
import { workspaceHandlers } from "./handlers/workspace"
import { instanceContextLayer } from "./middleware/instance-context"
import { workspaceRoutingLayer } from "./middleware/workspace-routing"
import { disposeMiddleware } from "./lifecycle"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { compressionLayer } from "./middleware/compression"
import { corsVaryFix } from "./middleware/cors-vary"
import { errorLayer } from "./middleware/error"
import { fenceLayer } from "./middleware/fence"
import { schemaErrorLayer } from "./middleware/schema-error"

export const context = Context.makeUnsafe<unknown>(new Map())

const cors = (corsOptions?: CorsOptions) =>
  HttpRouter.middleware(
    HttpMiddleware.cors({
      allowedOrigins: (origin) => isAllowedCorsOrigin(origin, corsOptions),
      maxAge: 86_400,
    }),
    { global: true },
  )

// Route tree:
// - rootApiRoutes: typed /global/* and control routes; auth is declared by RootHttpApi.
// - eventApiRoutes: typed SSE route with instance routing context and its existing API contract.
// - ptyConnectApiRoutes: typed WebSocket upgrade route with ticket-aware auth.
// - instanceApiRoutes: remaining typed instance routes.
// - uiRoute: raw catch-all fallback; auth is router middleware so public static assets can bypass it.
const authOnlyRouterLayer = authorizationRouterMiddleware.layer.pipe(Layer.provide(ServerAuth.Config.layer))
const httpApiAuthLayer = authorizationLayer.pipe(Layer.provide(ServerAuth.Config.layer))
const ptyConnectHttpApiAuthLayer = ptyConnectAuthorizationLayer.pipe(Layer.provide(ServerAuth.Config.layer))
const serverHttpApiAuthLayer = serverAuthorizationLayer.pipe(Layer.provide(ServerAuth.Config.layer))
const workspaceRoutingLive = workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal))
const rootApiRoutes = HttpApiBuilder.layer(RootHttpApi).pipe(
  Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers]),
  Layer.provide(schemaErrorLayer),
  Layer.provide(httpApiAuthLayer),
)
const eventApiRoutes = HttpApiBuilder.layer(EventApi).pipe(
  Layer.provide(eventHandlers),
  Layer.provide([httpApiAuthLayer, workspaceRoutingLive, instanceContextLayer]),
)
const ptyConnectApiRoutes = HttpApiBuilder.layer(PtyConnectApi).pipe(
  Layer.provide(ptyConnectHandlers),
  Layer.provide([ptyConnectHttpApiAuthLayer, workspaceRoutingLive, instanceContextLayer]),
)
const instanceApiRoutes = HttpApiBuilder.layer(InstanceHttpApi).pipe(
  Layer.provide([
    configHandlers,
    experimentalHandlers,
    fileHandlers,
    instanceHandlers,
    mcpHandlers,
    projectHandlers,
    projectCopyHandlers,
    ptyHandlers,
    questionHandlers,
    permissionHandlers,
    providerHandlers,
    sessionHandlers,
    syncHandlers,
    tuiHandlers,
    workspaceHandlers,
  ]),
)

const instanceRoutes = instanceApiRoutes.pipe(
  Layer.provide([httpApiAuthLayer, workspaceRoutingLive, instanceContextLayer, schemaErrorLayer]),
)
const serverRoutes = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(handlers),
  Layer.provide(PluginPtyEnvironment.layer),
  Layer.provide([serverHttpApiAuthLayer, v2SchemaErrorLayer]),
)

// `OpenApi.fromApi` is non-trivial; defer until /doc is actually hit so
// processes that never serve it (CLI, scripts) don't pay at module load.
// `HttpServerResponse.jsonUnsafe` runs JSON.stringify eagerly, so caching
// the response also caches the serialized body — every /doc request reuses
// the same Uint8Array instead of re-stringifying the spec.
const docResponse = lazy(() => HttpServerResponse.jsonUnsafe(OpenApi.fromApi(PublicApi)))

const docRoute = HttpRouter.use((router) => router.add("GET", "/doc", () => Effect.succeed(docResponse()))).pipe(
  Layer.provide(authOnlyRouterLayer),
)

// TKT-391: docs ship in the distribution, served from this instance rather than linking out to
// upstream's hosted docs. A specific prefix route, registered ahead of uiRoute's own catch-all
// (matches docRoute's own precedent for /doc) rather than folded into serveUIEffect -- docs have
// no upstream-proxy fallback (see docs.ts), a deliberately different failure mode than the UI's.
const docsRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const flags = yield* RuntimeFlags.Service
    yield* router.add("*", "/docs/*", (request) =>
      serveDocsEffect(new URL(request.url, "http://localhost").pathname, fs, flags.disableEmbeddedDocs),
    )
  }),
).pipe(Layer.provide(authOnlyRouterLayer))

const uiRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const client = yield* HttpClient.HttpClient
    const flags = yield* RuntimeFlags.Service
    yield* router.add("*", "/*", (request) =>
      serveUIEffect(request, { fs, client, disableEmbeddedWebUi: flags.disableEmbeddedWebUi }),
    )
  }),
).pipe(Layer.provide(authOnlyRouterLayer))

type RouteRequirements =
  | HttpRouter.HttpRouter
  | HttpRouter.Request<"Error", unknown>
  | HttpRouter.Request<"GlobalError", unknown>
  | HttpRouter.Request<"Requires", unknown>
  | HttpRouter.Request<"GlobalRequires", never>

const app = LayerNode.group([
  Npm.node,
  FSUtil.node,
  Database.node,
  Auth.node,
  Account.node,
  Config.node,
  Env.node,
  Git.node,
  Ripgrep.node,
  Storage.node,
  Snapshot.node,
  Plugin.node,
  ModelsDev.node,
  Provider.node,
  ProviderAuth.node,
  Agent.node,
  Skill.node,
  Discovery.node,
  Question.node,
  Permission.node,
  PermissionSaved.node,
  Todo.node,
  Session.node,
  SessionProjector.node,
  SessionStatus.node,
  BackgroundJob.node,
  RuntimeFlags.node,
  EventV2Bridge.node,
  SessionRunState.node,
  SessionProcessor.node,
  SessionCompaction.node,
  SessionRevert.node,
  SessionSummary.node,
  SessionPrompt.node,
  Instruction.node,
  LLM.node,
  LSP.node,
  MCP.node,
  McpAuth.node,
  Command.node,
  Truncate.node,
  ToolRegistry.node,
  Format.node,
  Project.node,
  Vcs.node,
  Workspace.node,
  Worktree.node,
  Installation.node,
  ShareNext.node,
  SessionShare.node,
  InstanceStore.node,
  httpClient,
  EventV2.node,
  ProjectV2.node,
  ProjectCopy.node,
  PtyTicket.node,
  // Pre-existing gap from #7 (TKT-317, goal/ledger), surfaced by TKT-315: session.goal.*
  // and session.ledger.* routes 500'd with "Service not found" through this path, because
  // this list -- not packages/server/routes.ts -- is what the httpapi exerciser and this V1
  // HttpApiApp actually build against. See FORK.md's node-assembly-sites list for every other
  // place a new global .node needs the same explicit entry.
  SessionGoal.node,
  SessionLedger.node,
  // Monitor.recoverNode (declare + startup recovery) is present -- reached by tool/monitor.ts's
  // monitor_create/monitor_list, registered via BuiltInTools.node inside locationServices.
  // MonitorRuntime.node is replaced with the real liveNode below (diary 2669): the tool itself
  // depends on Monitor.Service only, never MonitorRuntime -- the cycle that would have risked is
  // avoided by resolving LocationMutation/PermissionV2 PER CHECK (LocationServiceMap.Service.get,
  // same pattern SessionExecutionLocal uses) rather than at MonitorRuntime construction, so
  // MonitorRuntime.liveNode sits at this top level, never inside locationServices' own tree.
  Monitor.recoverNode,
  MonitorRuntime.node,
])

export function createRoutes(
  corsOptions?: CorsOptions,
): Layer.Layer<never, EffectConfig.ConfigError, RouteRequirements> {
  const locationServiceMapV2 = buildLocationServiceMap([[McpRuntime.node, McpRuntimeLive.node]])

  return Layer.mergeAll(
    rootApiRoutes,
    eventApiRoutes,
    ptyConnectApiRoutes,
    instanceRoutes,
    serverRoutes,
    docRoute,
    docsRoute,
    uiRoute,
  ).pipe(
    Layer.provide([
      errorLayer,
      compressionLayer,
      corsVaryFix,
      fenceLayer,
      cors(corsOptions),
      AppNodeBuilderV1.build(MoveSession.node, [[LocationServiceMap.node, locationServiceMapV2]]),
      HttpServer.layerServices,
    ]),
    Layer.provide(Layer.succeed(CorsConfig)(corsOptions)),
    Layer.provide(sessionLocationLayer),
    Layer.provide(locationLayer),
    Layer.provide(PtyEnvironment.layer),
    Layer.provide(
      AppNodeBuilderV1.build(SessionV2.node, [
        [LocationServiceMap.node, locationServiceMapV2],
        [SessionExecution.node, SessionExecutionLocal.node],
      ]),
    ),
    Layer.provide(locationServiceMapV2),

    Layer.provide(
      AppNodeBuilderV1.build(app, [
        [LocationServiceMap.node, locationServiceMapV2],
        [SessionExecution.node, SessionExecutionLocal.node],
        [MonitorRuntime.node, MonitorRuntime.liveNode],
      ]),
    ),
    // Must stay last: layers provided later in this pipe build beneath earlier ones,
    // so Observability must come after every service graph. Otherwise eagerly forked
    // fibers (e.g. the ModelsDev background refresh) capture Effect's default stdout
    // logger and corrupt the TUI (#34730).
    Layer.provideMerge(Observability.layer),
  )
}

export const routes = createRoutes()

export const webHandler = lazy(() =>
  HttpRouter.toWebHandler(routes, {
    disableLogger: true,
    memoMap,
    middleware: disposeMiddleware,
  }),
)

export * as HttpApiApp from "./server"
