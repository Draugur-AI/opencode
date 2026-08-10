import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { eq } from "drizzle-orm"
import { Effect, Exit } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectPreferenceTable, ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Hash } from "@opencode-ai/core/util/hash"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, ProjectV2.node])))

let seq = 0
const seedProject = (prefix: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const id = ProjectV2.ID.make(`prj_${prefix}_${seq++}`)
    yield* db
      .insert(ProjectTable)
      .values({ id, worktree: AbsolutePath.make("/repo"), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    return id
  })

function remoteID(remote: string) {
  return ProjectV2.ID.make(Hash.fast(`git-remote:${remote}`))
}

function abs(value: string) {
  return AbsolutePath.make(value)
}

function real(value: string) {
  return Effect.promise(() => fs.realpath(value)).pipe(Effect.map((value) => AbsolutePath.make(value)))
}

async function initRepo(dir: string, opts?: { commit?: boolean; remote?: string }) {
  await $`git init`.cwd(dir).quiet()
  await $`git config core.fsmonitor false`.cwd(dir).quiet()
  await $`git config commit.gpgsign false`.cwd(dir).quiet()
  await $`git config user.email test@opencode.test`.cwd(dir).quiet()
  await $`git config user.name Test`.cwd(dir).quiet()
  if (opts?.commit) await $`git commit --allow-empty -m root`.cwd(dir).quiet()
  if (opts?.remote) await $`git remote add origin ${opts.remote}`.cwd(dir).quiet()
}

async function rootCommit(dir: string) {
  return (await $`git rev-list --max-parents=0 HEAD`.cwd(dir).text()).trim()
}

describe("ProjectV2.resolve", () => {
  it.live("returns global for non-git directory", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.id).toBe(ProjectV2.ID.make("global"))
      expect(path.resolve(result.directory)).toBe(path.parse(tmp.path).root)
      expect(result.previous).toBeUndefined()
      expect(result.vcs).toBeUndefined()
    }),
  )

  it.live("returns git global for repo with no commits and no remote", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.id).toBe(ProjectV2.ID.make("global"))
      expect(result.directory).toBe(yield* real(tmp.path))
      expect(result.previous).toBeUndefined()
      expect(result.vcs?.type).toBe("git")
    }),
  )

  it.live("falls back to root commit when origin is missing", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true }))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.id).toBe(ProjectV2.ID.make(yield* Effect.promise(() => rootCommit(tmp.path))))
      expect(result.directory).toBe(yield* real(tmp.path))
      expect(result.previous).toBeUndefined()
      expect(result.vcs?.type).toBe("git")
    }),
  )

  it.live("prefers normalized origin over root commit", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true, remote: "git@github.com:Acme/App.git" }))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.id).toBe(remoteID("github.com/Acme/App"))
      expect(result.id).not.toBe(ProjectV2.ID.make(yield* Effect.promise(() => rootCommit(tmp.path))))
      expect(result.directory).toBe(yield* real(tmp.path))
      expect(result.vcs?.type).toBe("git")
    }),
  )

  it.live("normalizes ssh and https remotes to the same id", () =>
    Effect.gen(function* () {
      const ssh = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const https = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(ssh.path, { commit: true, remote: "git@github.com:owner/repo.git" }))
      yield* Effect.promise(() => initRepo(https.path, { commit: true, remote: "https://github.com/owner/repo.git" }))
      const project = yield* ProjectV2.Service

      const a = yield* project.resolve(abs(ssh.path))
      const b = yield* project.resolve(abs(https.path))

      expect(a.id).toBe(remoteID("github.com/owner/repo"))
      expect(b.id).toBe(a.id)
    }),
  )

  it.live("ignores file remotes and falls back to root commit", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true, remote: `file://${tmp.path}` }))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.id).toBe(ProjectV2.ID.make(yield* Effect.promise(() => rootCommit(tmp.path))))
    }),
  )

  it.live("returns previous cached id from common dir", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true, remote: "git@github.com:owner/repo.git" }))
      yield* Effect.promise(() => Bun.write(path.join(tmp.path, ".git", "opencode"), "old-id"))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.previous).toBe(ProjectV2.ID.make("old-id"))
      expect(result.id).toBe(remoteID("github.com/owner/repo"))
    }),
  )

  it.live("does not write the cache while resolving", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true, remote: "git@github.com:owner/repo.git" }))
      const project = yield* ProjectV2.Service

      yield* project.resolve(abs(tmp.path))

      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, ".git", "opencode")).exists())).toBe(false)
    }),
  )

  it.live("resolves from nested directories to repo root", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true }))
      yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "a", "b"), { recursive: true }))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(path.join(tmp.path, "a", "b")))

      expect(result.directory).toBe(yield* real(tmp.path))
    }),
  )

  it.live("linked worktree returns opened worktree directory and previous from common dir", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const worktree = `${tmp.path}-worktree`
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`rm -rf ${worktree}`.quiet().nothrow()).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true, remote: "git@github.com:owner/repo.git" }))
      yield* Effect.promise(() => Bun.write(path.join(tmp.path, ".git", "opencode"), "old-id"))
      yield* Effect.promise(() => $`git worktree add ${worktree} -b test-${Date.now()}`.cwd(tmp.path).quiet())
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(worktree))

      expect(result.directory).toBe(yield* real(worktree))
      expect(result.previous).toBe(ProjectV2.ID.make("old-id"))
      expect(result.id).toBe(remoteID("github.com/owner/repo"))
      expect(result.vcs?.type).toBe("git")
    }),
  )
})

describe("ProjectV2 list/get/updateMetadata", () => {
  it.effect("lists and gets a seeded project", () =>
    Effect.gen(function* () {
      const id = yield* seedProject("list")
      const project = yield* ProjectV2.Service

      const list = yield* project.list()
      expect(list.some((entry) => entry.id === id)).toBe(true)

      const got = yield* project.get(id)
      expect(got?.id).toBe(id)
      expect(got?.worktree).toBe("/repo")
    }),
  )

  it.effect("get returns undefined for an unknown project", () =>
    Effect.gen(function* () {
      const project = yield* ProjectV2.Service
      const got = yield* project.get(ProjectV2.ID.make("prj_does_not_exist"))
      expect(got).toBeUndefined()
    }),
  )

  // ProjectV2.Service does not publish project.updated itself -- see the comment on
  // ProjectV2.Info in packages/core/src/project.ts (a direct EventV2 dependency here closes a
  // circular import through event.ts -> location.ts -> project.ts). Each caller publishes for
  // itself; that's exercised at the caller (the v2 server handler's httpapi-exercise scenario
  // and the V1 route adapter), not here.
  it.effect("updateMetadata updates name, icon, and commands", () =>
    Effect.gen(function* () {
      const id = yield* seedProject("update")
      const project = yield* ProjectV2.Service

      const updated = yield* project.updateMetadata({
        projectID: id,
        name: "My Project",
        icon: { url: "https://example.test/icon.png" },
        commands: { start: "bun dev" },
      })

      expect(updated.name).toBe("My Project")
      expect(updated.icon?.url).toBe("https://example.test/icon.png")
      expect(updated.commands?.start).toBe("bun dev")

      const refetched = yield* project.get(id)
      expect(refetched?.name).toBe("My Project")
    }),
  )

  it.effect("updateMetadata fails with NotFoundError for an unknown project", () =>
    Effect.gen(function* () {
      const project = yield* ProjectV2.Service
      const exit = yield* Effect.exit(project.updateMetadata({ projectID: ProjectV2.ID.make("prj_missing"), name: "x" }))
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})

describe("ProjectPreference compare-and-set", () => {
  it.effect("reads defaults for a project with no preference row", () =>
    Effect.gen(function* () {
      const id = yield* seedProject("pref-default")
      const project = yield* ProjectV2.Service

      const pref = yield* project.preferenceGet(id)

      expect(pref).toEqual({
        projectID: id,
        favorite: false,
        hidden: false,
        rank: undefined,
        lastOpenedAt: undefined,
        revision: 0,
      })
    }),
  )

  it.effect("first patch with no expectedRevision creates the row at revision 1", () =>
    Effect.gen(function* () {
      const id = yield* seedProject("pref-create")
      const project = yield* ProjectV2.Service

      const result = yield* project.preferencePatch({ projectID: id, patch: { favorite: true } })

      expect(result.favorite).toBe(true)
      expect(result.revision).toBe(1)

      const reread = yield* project.preferenceGet(id)
      expect(reread.favorite).toBe(true)
      expect(reread.revision).toBe(1)
    }),
  )

  it.effect("a second create attempt (no expectedRevision) conflicts once a row exists", () =>
    Effect.gen(function* () {
      const id = yield* seedProject("pref-double-create")
      const project = yield* ProjectV2.Service
      yield* project.preferencePatch({ projectID: id, patch: { favorite: true } })

      const exit = yield* Effect.exit(project.preferencePatch({ projectID: id, patch: { hidden: true } }))

      expect(Exit.isFailure(exit)).toBe(true)
      const failure = Exit.isFailure(exit) ? JSON.stringify(exit.cause) : ""
      expect(failure).toContain("ProjectPreference.Conflict")
      expect(failure).toContain('"revision":1')
      // The failed attempt must not have overwritten the existing row.
      const reread = yield* project.preferenceGet(id)
      expect(reread.favorite).toBe(true)
      expect(reread.hidden).toBe(false)
    }),
  )

  it.effect("patch with the correct expectedRevision succeeds and increments revision", () =>
    Effect.gen(function* () {
      const id = yield* seedProject("pref-cas-ok")
      const project = yield* ProjectV2.Service
      const created = yield* project.preferencePatch({ projectID: id, patch: { favorite: true } })

      const result = yield* project.preferencePatch({
        projectID: id,
        patch: { hidden: true },
        expectedRevision: created.revision,
      })

      expect(result.revision).toBe(2)
      expect(result.hidden).toBe(true)
      // Prior fields not in this patch are preserved as absent (patch semantics), not reset.
      const row = yield* Effect.gen(function* () {
        const { db } = yield* Database.Service
        return yield* db
          .select()
          .from(ProjectPreferenceTable)
          .where(eq(ProjectPreferenceTable.project_id, id))
          .get()
          .pipe(Effect.orDie)
      })
      expect(row?.revision).toBe(2)
    }),
  )

  it.effect("patch with a stale expectedRevision is rejected as a conflict, and does not overwrite", () =>
    Effect.gen(function* () {
      const id = yield* seedProject("pref-cas-stale")
      const project = yield* ProjectV2.Service
      yield* project.preferencePatch({ projectID: id, patch: { favorite: true } })
      yield* project.preferencePatch({ projectID: id, patch: { hidden: true }, expectedRevision: 1 })

      // A caller still holding revision 1 (the pre-hidden-patch value) retries against it.
      const exit = yield* Effect.exit(
        project.preferencePatch({ projectID: id, patch: { rank: "a0" }, expectedRevision: 1 }),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      const failure = Exit.isFailure(exit) ? JSON.stringify(exit.cause) : ""
      expect(failure).toContain("ProjectPreference.Conflict")
      expect(failure).toContain('"revision":2')
      const reread = yield* project.preferenceGet(id)
      expect(reread.rank).toBeUndefined()
      expect(reread.revision).toBe(2)
    }),
  )
})
