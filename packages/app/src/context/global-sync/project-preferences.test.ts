import { describe, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import type { ServerScope } from "@/utils/server-scope"
import {
  createProjectPreferenceCache,
  projectPreferenceKey,
  type ProjectPreferenceValue,
} from "./project-preferences"
import type { ProjectClient } from "@/utils/project-client"

const scope = "test-scope" as ServerScope

function value(patch: Partial<ProjectPreferenceValue> & { projectID: string }): ProjectPreferenceValue {
  return { favorite: false, hidden: false, revision: 0, ...patch }
}

function stubClient(overrides: Partial<ProjectClient> = {}): ProjectClient {
  return {
    list: async () => [],
    get: async () => undefined as never,
    updateMetadata: async () => undefined as never,
    preferenceRead: async ({ projectID }) => value({ projectID }),
    preferenceWrite: async (input) =>
      value({
        projectID: input.projectID,
        favorite: input.favorite ?? false,
        rank: input.rank,
        hidden: input.hidden ?? false,
        lastOpenedAt: input.lastOpenedAt,
        revision: (input.expectedRevision ?? 0) + 1,
      }),
    ...overrides,
  }
}

describe("project preference cache", () => {
  test("get() returns a sensible default before anything is cached", () => {
    const cache = createProjectPreferenceCache(new QueryClient(), scope, stubClient())
    expect(cache.get("prj_1")).toEqual(value({ projectID: "prj_1" }))
  })

  test("ensure() fetches once and populates the cache at the (scope, projectID) key", async () => {
    let calls = 0
    const client = stubClient({
      preferenceRead: async ({ projectID }) => {
        calls++
        return value({ projectID, favorite: true, revision: 3 })
      },
    })
    const queryClient = new QueryClient()
    const cache = createProjectPreferenceCache(queryClient, scope, client)

    const result = await cache.ensure("prj_1")
    expect(result).toEqual(value({ projectID: "prj_1", favorite: true, revision: 3 }))
    expect(cache.get("prj_1")).toEqual(result)
    expect(queryClient.getQueryData<ProjectPreferenceValue>(projectPreferenceKey(scope, "prj_1"))).toEqual(result)

    // A second ensure() for the same project hits the cache, not the network.
    await cache.ensure("prj_1")
    expect(calls).toBe(1)
  })

  test("apply() always wins, even for a project never individually fetched -- real-time sync", () => {
    const queryClient = new QueryClient()
    const cache = createProjectPreferenceCache(queryClient, scope, stubClient())

    cache.apply({
      type: "project.preference.updated",
      properties: value({ projectID: "prj_2", favorite: true, revision: 5 }),
    })

    expect(cache.get("prj_2")).toEqual(value({ projectID: "prj_2", favorite: true, revision: 5 }))
  })

  test("apply() ignores events of a different type", () => {
    const queryClient = new QueryClient()
    const cache = createProjectPreferenceCache(queryClient, scope, stubClient())

    cache.apply({ type: "project.updated", properties: value({ projectID: "prj_3", favorite: true }) })

    expect(cache.get("prj_3")).toEqual(value({ projectID: "prj_3" }))
  })

  test("write() updates optimistically, then settles to the server's returned revision", async () => {
    const queryClient = new QueryClient()
    const cache = createProjectPreferenceCache(queryClient, scope, stubClient())

    const promise = cache.write({ projectID: "prj_4", favorite: true })
    // Optimistic value is visible synchronously, before the write resolves.
    expect(cache.get("prj_4").favorite).toBe(true)

    const result = await promise
    expect(result).toEqual(value({ projectID: "prj_4", favorite: true, revision: 1 }))
    expect(cache.get("prj_4")).toEqual(result)
  })

  test("write() reverts the optimistic value on failure -- a conflict never leaves an unconfirmed guess cached", async () => {
    const queryClient = new QueryClient()
    const client = stubClient({
      preferenceWrite: async () => {
        throw new Error("409 Conflict")
      },
    })
    const cache = createProjectPreferenceCache(queryClient, scope, client)

    // Seed a known-good cached value before the conflicting write.
    cache.apply({
      type: "project.preference.updated",
      properties: value({ projectID: "prj_5", favorite: false, revision: 2 }),
    })

    await expect(cache.write({ projectID: "prj_5", favorite: true, expectedRevision: 2 })).rejects.toThrow(
      "409 Conflict",
    )
    expect(cache.get("prj_5")).toEqual(value({ projectID: "prj_5", favorite: false, revision: 2 }))
  })

  test("write() defaults expectedRevision to the currently cached revision when the caller omits it", async () => {
    const calls: unknown[] = []
    const client = stubClient({
      preferenceWrite: async (input) => {
        calls.push(input)
        return value({ projectID: input.projectID, favorite: true, revision: 8 })
      },
    })
    const queryClient = new QueryClient()
    const cache = createProjectPreferenceCache(queryClient, scope, client)
    cache.apply({
      type: "project.preference.updated",
      properties: value({ projectID: "prj_6", revision: 7 }),
    })

    await cache.write({ projectID: "prj_6", favorite: true })

    expect(calls).toEqual([{ projectID: "prj_6", favorite: true, expectedRevision: 7 }])
  })
})
