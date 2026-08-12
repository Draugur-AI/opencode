import { OpenCode } from "@opencode-ai/client/effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Monitor } from "@opencode-ai/core/monitor"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionGoal } from "@opencode-ai/core/session/goal"
import { SessionLedger } from "@opencode-ai/core/session/ledger"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { createEmbeddedRoutes } from "@opencode-ai/server/routes"
import { Context, Effect, Layer, Scope } from "effect"
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http"

export const create = Effect.fn("OpenCode.create")(function* () {
  const scope = yield* Scope.Scope
  const memoMap = yield* Layer.makeMemoMap
  const context = yield* Layer.buildWithMemoMap(
    AppNodeBuilder.build(
      LayerNode.group([
        ApplicationTools.node,
        EventV2.node,
        PermissionSaved.node,
        ProjectV2.node,
        SessionGoal.node,
        SessionLedger.node,
        // Monitor.recoverNode (declare + startup recovery) is present. MonitorRuntime.node stays
        // at its bound default HERE deliberately -- this SDK's actual HTTP surface is
        // createEmbeddedRoutes() from packages/server, which wires the real
        // MonitorRuntime.liveNode itself; this separate top-level graph (ApplicationTools/
        // EventV2/etc, this SDK's own direct service needs) never reaches a running session.
        Monitor.recoverNode,
        Database.node,
      ]),
    ),
    memoMap,
    scope,
  )
  const tools = Context.get(context, ApplicationTools.Service)
  const permissions = Context.get(context, PermissionSaved.Service)
  const project = Context.get(context, ProjectV2.Service)
  const events = Context.get(context, EventV2.Service)
  const goal = Context.get(context, SessionGoal.Service)
  const ledger = Context.get(context, SessionLedger.Service)
  const database = Context.get(context, Database.Service)
  const web = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        createEmbeddedRoutes().pipe(
          HttpRouter.provideRequest(
            Layer.mergeAll(
              Layer.succeed(PermissionSaved.Service, permissions),
              Layer.succeed(ProjectV2.Service, project),
              Layer.succeed(EventV2.Service, events),
              Layer.succeed(SessionGoal.Service, goal),
              Layer.succeed(SessionLedger.Service, ledger),
              Layer.succeed(Database.Service, database),
            ),
          ),
          Layer.provide(HttpServer.layerServices),
        ),
        { disableLogger: true, memoMap },
      ),
    ),
    (web) => Effect.promise(web.dispose),
  )
  const fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => web.handler(new Request(input, init)), {
    preconnect: () => undefined,
  }) satisfies typeof globalThis.fetch
  const client = yield* OpenCode.make({ baseUrl: "http://opencode.local" }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  )
  return {
    ...client,
    tools: { register: tools.register },
  }
})

export type Interface = Effect.Success<ReturnType<typeof create>>

export class Service extends Context.Service<Service, Interface>()("@opencode-ai/sdk-next/OpenCode") {}

export const layer = Layer.effect(Service, create())
