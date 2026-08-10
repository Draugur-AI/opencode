#!/usr/bin/env bun
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"

import { createClient } from "@hey-api/openapi-ts"

const opencode = path.resolve(dir, "../../opencode")

await $`bun dev generate > ${dir}/openapi.json`.cwd(opencode)

const document = (await Bun.file("./openapi.json").json()) as {
  components?: { schemas?: Record<string, unknown> }
  [key: string]: unknown
}
const schemas = document.components?.schemas
if (schemas) {
  const refPrefix = "#/components/schemas/"

  // Mutates in place -- `schemas` below stays the same object across passes, so each pass sees
  // the previous pass's redirected refs without needing to re-thread a rebuilt document.
  const rewriteRefs = (value: unknown, rename: ReadonlyMap<string, string>): void => {
    if (Array.isArray(value)) {
      value.forEach((child) => rewriteRefs(child, rename))
      return
    }
    if (typeof value !== "object" || value === null) return
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string" && child.startsWith(refPrefix)) {
        const name = child.slice(refPrefix.length)
        const target = rename.get(name)
        if (target) (value as Record<string, unknown>)[key] = refPrefix + target
      } else {
        rewriteRefs(child, rename)
      }
    }
  }

  // hey-api/openapi-ts walks each reference SITE for a shared schema (e.g. SessionEvent.Durable
  // is used at two separate endpoints) as its own naming pass, so a schema reachable from more
  // than one site -- or, since our own TKT-318 change, a union whose member now legitimately has
  // two distinct shapes sharing one discriminant (a versioned successor kept alongside the old
  // decoder, see Compaction.EndedV1/Ended) -- can come out as two byte-identical schemas under
  // different names (`SessionDurableEvent` / `SessionDurableEvent1`). Collapsing by structural
  // equality (not a name pattern) generalizes what used to be a narrow "delete this one
  // known-unreachable name" check into a fixed-point pass: redirect every $ref at a duplicate to
  // its first-seen canonical twin, delete the duplicate, and repeat -- a parent union can itself
  // become a duplicate only once ITS members have already collapsed to shared names.
  const maxPasses = Object.keys(schemas).length
  let converged = false
  for (let pass = 0; pass < maxPasses; pass++) {
    const byCanonical = new Map<string, string>()
    const rename = new Map<string, string>()
    for (const name of Object.keys(schemas).sort()) {
      const canonical = JSON.stringify(schemas[name])
      const existing = byCanonical.get(canonical)
      if (existing) rename.set(name, existing)
      else byCanonical.set(canonical, name)
    }
    if (rename.size === 0) {
      converged = true
      break
    }
    for (const name of rename.keys()) delete schemas[name]
    rewriteRefs(document, rename)
  }
  // Ran out of passes without reaching a fixed point -- either a bug in this loop, or a chain of
  // duplicates longer than the schema count should ever allow. Fail loudly here rather than
  // silently shipping unresolved duplicate schemas to codegen.
  if (!converged) throw new Error("Session event schema dedup did not converge")

  await Bun.write("./openapi.json", JSON.stringify(document))
}

await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/v2/gen",
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "OpencodeClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

const generatedTypes = await Bun.file("./src/v2/gen/types.gen.ts").text()
const historyTypesPatched = generatedTypes.replace(
  /(export type V2SessionHistoryData = \{[\s\S]*?query\?: \{\s*limit\?: )string([;,]\s*after\?: )string/,
  "$1number$2number",
)
if (historyTypesPatched === generatedTypes) {
  throw new Error("Session history numeric query patch did not apply")
}
await Bun.write("./src/v2/gen/types.gen.ts", historyTypesPatched)

const generatedSdk = await Bun.file("./src/v2/gen/sdk.gen.ts").text()
const historySdkPatched = generatedSdk.replace(
  /(Get session history[\s\S]*?parameters: \{\s*sessionID: string[;,]\s*limit\?: )string([;,]\s*after\?: )string/,
  "$1number$2number",
)
if (historySdkPatched === generatedSdk) {
  throw new Error("Session history numeric SDK patch did not apply")
}
await Bun.write("./src/v2/gen/sdk.gen.ts", historySdkPatched)

// Patch a @hey-api/openapi-ts codegen bug: SseFn incorrectly passes the
// endpoint's TError into the second generic of ServerSentEventsResult, which
// is the AsyncGenerator's TReturn slot. Iterator return values have nothing
// to do with HTTP errors, and any consumer that calls `.return()` or returns
// from a mock generator gets type-checked against the wrong shape. Drop the
// arg so TReturn defaults to void.
const sseTypesPath = "./src/v2/gen/client/types.gen.ts"
const sseTypesFile = Bun.file(sseTypesPath)
const sseTypesSource = await sseTypesFile.text()
const sseTypesPatched = sseTypesSource.replace(
  "=> Promise<ServerSentEventsResult<TData, TError>>",
  "=> Promise<ServerSentEventsResult<TData>>",
)
if (sseTypesPatched === sseTypesSource) {
  throw new Error(`SseFn patch did not apply; @hey-api/openapi-ts output may have changed (${sseTypesPath})`)
}
await Bun.write(sseTypesPath, sseTypesPatched)

await $`bun prettier --write src/gen`
await $`bun prettier --write src/v2`
await $`rm -rf dist`
await $`bun tsc`
await $`rm openapi.json`
