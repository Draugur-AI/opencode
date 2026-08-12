import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { cspForHtml } from "./ui"

let embeddedDocsPromise: Promise<Record<string, string> | null> | undefined

// TKT-391: docs ship IN the distribution, unlike the web UI (ui.ts) there is deliberately no
// upstream fallback here. Serving upstream's docs.opencode.ai when this fork's own bundle isn't
// embedded would document a different program -- the exact problem TKT-328's diary 2528 found in
// the console's openapi.json proxy. Not embedded means not available, visibly, not silently wrong.
export function embeddedDocs(disableEmbeddedDocs: boolean) {
  if (disableEmbeddedDocs) return Promise.resolve(null)
  return (embeddedDocsPromise ??=
    // @ts-expect-error - generated file at build time
    import("opencode-docs.gen.ts").then((module) => module.default as Record<string, string>).catch(() => null))
}

function notEmbedded() {
  return HttpServerResponse.jsonUnsafe(
    { error: "Docs are not embedded in this build. Run a --single build without --skip-embed-docs." },
    { status: 404 },
  )
}

function docsResponse(file: string, body: Uint8Array, status: number) {
  const mime = FSUtil.mimeType(file)
  const headers = new Headers({ "content-type": mime })
  if (mime.startsWith("text/html")) {
    headers.set("content-security-policy", cspForHtml(new TextDecoder().decode(body)))
  }
  return HttpServerResponse.raw(body, { status, headers })
}

// Starlight's own build already produces a branded 404.html -- served with a real 404 status,
// not silently swapped for the homepage the way an SPA's index.html fallback would be.
function lookup(embeddedWebDocs: Record<string, string>, requestPath: string) {
  const relative = requestPath.replace(/^\/docs\/?/, "").replace(/\/$/, "")
  const direct = embeddedWebDocs[relative]
  if (direct) return { file: direct, status: 200 }
  const indexed = embeddedWebDocs[relative ? `${relative}/index.html` : "index.html"]
  if (indexed) return { file: indexed, status: 200 }
  const notFoundPage = embeddedWebDocs["404.html"]
  if (notFoundPage) return { file: notFoundPage, status: 404 }
  return undefined
}

export function serveEmbeddedDocsEffect(
  requestPath: string,
  fs: FSUtil.Interface,
  embeddedWebDocs: Record<string, string>,
) {
  const found = lookup(embeddedWebDocs, requestPath)
  if (!found) return Effect.succeed(notEmbedded())

  return fs.readFile(found.file).pipe(
    Effect.map((body) => docsResponse(found.file, body, found.status)),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(notEmbedded())),
  )
}

export function serveDocsEffect(requestPath: string, fs: FSUtil.Interface, disableEmbeddedDocs: boolean) {
  return Effect.gen(function* () {
    const embeddedWebDocs = yield* Effect.promise(() => embeddedDocs(disableEmbeddedDocs))
    if (!embeddedWebDocs) return notEmbedded()

    return yield* serveEmbeddedDocsEffect(requestPath, fs, embeddedWebDocs)
  })
}
