import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { serveDocsEffect, serveEmbeddedDocsEffect } from "../../src/server/shared/docs"
import { testEffect } from "../lib/effect"

const fsUtilLayer = AppNodeBuilder.build(FSUtil.node)
const it = testEffect(Layer.mergeAll(fsUtilLayer, RuntimeFlags.layer()))

function responseText(response: Response) {
  return Effect.promise(() => response.text())
}

function docsApp(disableEmbeddedDocs: boolean) {
  const handler = HttpRouter.toWebHandler(
    HttpRouter.use((router) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        yield* router.add("*", "/docs/*", (request) =>
          serveDocsEffect(new URL(request.url, "http://localhost").pathname, fs, disableEmbeddedDocs),
        )
      }),
    ).pipe(Layer.provide([fsUtilLayer, RuntimeFlags.layer({ disableEmbeddedDocs })])),
    { disableLogger: true },
  ).handler
  return {
    request(input: string | URL | Request, init?: RequestInit) {
      return Effect.promise(() =>
        Promise.resolve(
          handler(
            input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init),
            HttpApiApp.context,
          ),
        ),
      )
    },
  }
}

describe("HttpApi docs", () => {
  it.live("returns a 404 'not embedded' response when docs are disabled", () =>
    Effect.gen(function* () {
      const response = yield* docsApp(true).request("/docs/")

      expect(response.status).toBe(404)
      const body = yield* Effect.promise(() => response.json())
      expect(body.error).toContain("not embedded")
    }),
  )

  // In a test build there is no generated opencode-docs.gen.ts module, so the dynamic
  // import in embeddedDocs() fails and is caught to null -- this is the real behavior
  // of an --skip-embed-docs build, not a test-only stand-in.
  it.live("returns a 404 'not embedded' response when no bundle was compiled in", () =>
    Effect.gen(function* () {
      const response = yield* docsApp(false).request("/docs/")

      expect(response.status).toBe(404)
      const body = yield* Effect.promise(() => response.json())
      expect(body.error).toContain("not embedded")
    }),
  )

  it.live("serves an exact file match", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const response = yield* serveEmbeddedDocsEffect(
        "/docs/themes/",
        { ...fs, readFile: (path) => Effect.succeed(new TextEncoder().encode(`<html>${path}</html>`)) },
        { "themes/index.html": "/$bunfs/root/themes/index.html" },
      ).pipe(Effect.map(HttpServerResponse.toWeb))

      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/html")
      expect(yield* responseText(response)).toBe("<html>/$bunfs/root/themes/index.html</html>")
    }),
  )

  it.live("resolves a bare path without a trailing slash to its index page", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      let readPath: string | undefined
      const response = yield* serveEmbeddedDocsEffect(
        "/docs/themes",
        {
          ...fs,
          readFile: (path) => {
            readPath = path
            return Effect.succeed(new TextEncoder().encode("<html>themes</html>"))
          },
        },
        { "themes/index.html": "/$bunfs/root/themes/index.html" },
      ).pipe(Effect.map(HttpServerResponse.toWeb))

      expect(response.status).toBe(200)
      expect(readPath).toBe("/$bunfs/root/themes/index.html")
      expect(yield* responseText(response)).toBe("<html>themes</html>")
    }),
  )

  it.live("resolves the docs root to its own index page", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const response = yield* serveEmbeddedDocsEffect(
        "/docs/",
        { ...fs, readFile: () => Effect.succeed(new TextEncoder().encode("<html>root</html>")) },
        { "index.html": "/$bunfs/root/index.html" },
      ).pipe(Effect.map(HttpServerResponse.toWeb))

      expect(response.status).toBe(200)
      expect(yield* responseText(response)).toBe("<html>root</html>")
    }),
  )

  it.live("does not resolve prototype-chain properties for a request path", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      let readPath: unknown
      const response = yield* serveEmbeddedDocsEffect(
        "/docs/__proto__/",
        {
          ...fs,
          readFile: (path) => {
            readPath = path
            return Effect.succeed(new TextEncoder().encode("<html>not found</html>"))
          },
        },
        { "404.html": "/$bunfs/root/404.html" },
      ).pipe(Effect.map(HttpServerResponse.toWeb))

      // Plain-object property lookup resolves __proto__/constructor/toString through the
      // prototype chain rather than the map's own keys -- guarded with Object.hasOwn.
      // Falls through to the branded 404 page like any other unmatched path, reading the
      // real 404.html file path rather than something derived from Object.prototype.
      expect(readPath).toBe("/$bunfs/root/404.html")
      expect(response.status).toBe(404)
    }),
  )

  it.live("falls back to the bundle's own branded 404 page, served with a 404 status", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const response = yield* serveEmbeddedDocsEffect(
        "/docs/nonexistent/",
        { ...fs, readFile: () => Effect.succeed(new TextEncoder().encode("<html>not found</html>")) },
        { "404.html": "/$bunfs/root/404.html" },
      ).pipe(Effect.map(HttpServerResponse.toWeb))

      expect(response.status).toBe(404)
      expect(yield* responseText(response)).toBe("<html>not found</html>")
    }),
  )

  it.live("returns the generic 'not embedded' response when the bundle has no 404 page either", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const response = yield* serveEmbeddedDocsEffect(
        "/docs/nonexistent/",
        { ...fs, readFile: () => Effect.die("should not read a file when nothing matched") },
        { "index.html": "/$bunfs/root/index.html" },
      ).pipe(Effect.map(HttpServerResponse.toWeb))

      expect(response.status).toBe(404)
      const body = yield* Effect.promise(() => response.json())
      expect(body.error).toContain("not embedded")
    }),
  )
})
