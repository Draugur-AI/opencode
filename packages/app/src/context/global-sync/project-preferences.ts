import type { QueryClient } from "@tanstack/solid-query"
import type { ProjectClient, ProjectPreferenceWrite } from "@/utils/project-client"
import type { ServerScope } from "@/utils/server-scope"

export type ProjectPreferenceValue = {
  readonly projectID: string
  readonly favorite: boolean
  readonly rank?: string
  readonly hidden: boolean
  readonly lastOpenedAt?: number
  readonly revision: number
}

export type ProjectPreferenceEvent = {
  type: "project.preference.updated"
  properties: ProjectPreferenceValue
}

export const projectPreferenceKey = (scope: ServerScope, projectID: string) =>
  [scope, "project-preference", projectID] as const

const defaultPreference = (projectID: string): ProjectPreferenceValue => ({
  projectID,
  favorite: false,
  hidden: false,
  revision: 0,
})

/** Cached by (server scope, project ID) -- one TanStack Query entry per project, not one blob for all. */
export function createProjectPreferenceCache(queryClient: QueryClient, scope: ServerScope, client: ProjectClient) {
  const keyFor = (projectID: string) => projectPreferenceKey(scope, projectID)
  const get = (projectID: string): ProjectPreferenceValue =>
    queryClient.getQueryData<ProjectPreferenceValue>(keyFor(projectID)) ?? defaultPreference(projectID)

  return {
    get,
    /**
     * The raw fetch, with no queryClient involvement -- the queryFn a `useQuery`/`useQueries`
     * observer for this same key calls. `ensure` below wraps `fetchQuery` for this same key, so
     * calling `ensure` FROM a live observer for that key is self-referential and never resolves.
     */
    read: (projectID: string) => client.preferenceRead({ projectID }),
    /** Lazily fetches on first need; a cache hit resolves without a network round-trip. */
    ensure(projectID: string) {
      return queryClient.fetchQuery({
        queryKey: keyFor(projectID),
        queryFn: () => client.preferenceRead({ projectID }),
        staleTime: Infinity,
      })
    },
    /** Real-time sync: a push event always wins over whatever's cached, fetched or not. */
    apply(event: { readonly type: string; readonly properties?: unknown }) {
      if (event.type !== "project.preference.updated") return
      const value = event.properties as ProjectPreferenceValue
      queryClient.setQueryData<ProjectPreferenceValue>(keyFor(value.projectID), value)
    },
    /**
     * Optimistic write: the cache updates immediately with the patch, then settles to whatever
     * revision the server actually returns. A conflict (409, stale expectedRevision) or any other
     * failure reverts to the pre-write value rather than leaving an unconfirmed guess cached.
     */
    async write(input: ProjectPreferenceWrite): Promise<ProjectPreferenceValue> {
      const key = keyFor(input.projectID)
      const before = get(input.projectID)
      queryClient.setQueryData<ProjectPreferenceValue>(key, { ...before, ...input })
      try {
        const result = await client.preferenceWrite({
          ...input,
          expectedRevision: input.expectedRevision ?? before.revision,
        })
        queryClient.setQueryData<ProjectPreferenceValue>(key, result)
        return result
      } catch (error) {
        queryClient.setQueryData<ProjectPreferenceValue>(key, before)
        throw error
      }
    },
  }
}

export type ProjectPreferenceCache = ReturnType<typeof createProjectPreferenceCache>
