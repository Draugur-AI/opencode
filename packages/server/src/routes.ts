import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { Credential } from "@opencode-ai/core/credential"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { PtyTicket } from "@opencode-ai/core/pty/ticket"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { Monitor } from "@opencode-ai/core/monitor"
import { MonitorRuntime } from "@opencode-ai/core/monitor/runtime"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionGoal } from "@opencode-ai/core/session/goal"
import { SessionLedger } from "@opencode-ai/core/session/ledger"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Layer, Option } from "effect"
import { Api } from "./api"
import { ServerAuth } from "./auth"
import { handlers } from "./handlers"
import { authorizationLayer } from "./middleware/authorization"
import { schemaErrorLayer } from "./middleware/schema-error"
import { PtyEnvironment } from "./pty-environment"
import { layer as locationLayer } from "./location"
import { sessionLocationLayer } from "./middleware/session-location"

const applicationServices = LayerNode.group([
  Database.node,
  EventV2.node,
  httpClient,
  ToolOutputStore.cleanupNode,
  SessionV2.node,
  PermissionSaved.node,
  PtyTicket.node,
  Credential.node,
  PtyEnvironment.node,
  LocationServiceMap.node,
  // Explicit, not relying on transitive auto-discovery: that mechanism is fragile past a
  // certain graph size (see FORK.md-adjacent findings on TKT-315/TKT-317 -- this exact set
  // of nodes newly failed to auto-resolve, at runtime ("Service not found") for these three
  // and at the type level (cli, sdk-next) for ProjectV2, only once both landed together).
  ProjectV2.node,
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

export function createRoutes(password?: string) {
  return makeRoutes(
    password
      ? ServerAuth.Config.configLayer({ username: "opencode", password: Option.some(password) })
      : ServerAuth.Config.layer,
  )
}

export function createEmbeddedRoutes() {
  return makeRoutes(ServerAuth.Config.configLayer({ username: "opencode", password: Option.none() }))
}

function makeRoutes<AuthError, AuthServices>(auth: Layer.Layer<ServerAuth.Config, AuthError, AuthServices>) {
  const serviceLayer = AppNodeBuilder.build(applicationServices, [
    [SessionExecution.node, SessionExecutionLocal.node],
    [MonitorRuntime.node, MonitorRuntime.liveNode],
  ])

  return HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(handlers),
    Layer.provide(sessionLocationLayer),
    Layer.provide(locationLayer),
    Layer.provide(authorizationLayer),
    Layer.provide(schemaErrorLayer),
    Layer.provide(auth),
    Layer.provide(serviceLayer),
  )
}

export const routes = createRoutes()

export const webHandler = () =>
  HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), { disableLogger: true })
