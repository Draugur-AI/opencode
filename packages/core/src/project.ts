export * as ProjectV2 from "./project"
export * as Project from "./project"

import { Context, Effect, Layer, Schema, Types } from "effect"
import path from "path"
import { eq } from "drizzle-orm"
import { AbsolutePath } from "./schema"
import { FSUtil } from "./fs-util"
import { Git } from "./git"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { Hash } from "./util/hash"
import { ProjectDirectories } from "./project/directories"
import { ProjectSchema } from "./project/schema"
import { ProjectPreference } from "./project/preference"
import { Project as ProjectSchemaPublic } from "@opencode-ai/schema/project"
import { ProjectTable } from "./project/sql"

export const ID = ProjectSchema.ID
export type ID = ProjectSchema.ID

export const Vcs = ProjectSchema.Vcs
export type Vcs = ProjectSchema.Vcs

/** The full public project representation. Owned here now — see the build post, "Projects:
 * finish the V2 move before adding favorites".
 *
 * This service deliberately does NOT depend on EventV2: event.ts imports location.ts, which
 * imports this module for Project.node — importing EventV2 back here closes that cycle and
 * throws "Cannot access 'node' before initialization" at module load (a real TDZ crash, not a
 * type error). Callers publish project.updated / project.preference.updated themselves after
 * calling updateMetadata/preferencePatch — see the V1 adapter and the v2 server handler. */
export const Info = ProjectSchemaPublic.Info
export type Info = Types.DeepMutable<ProjectSchemaPublic.Info>
export const Event = ProjectSchemaPublic.Event

export const DirectoriesInput = ProjectDirectories.ListInput
export type DirectoriesInput = typeof DirectoriesInput.Type

export const Directories = ProjectDirectories.ListOutput
export type Directories = typeof Directories.Type

export const UpdateMetadataInput = Schema.Struct({
  projectID: ID,
  name: Schema.optional(Schema.String),
  icon: Schema.optional(ProjectSchemaPublic.Icon),
  commands: Schema.optional(ProjectSchemaPublic.Commands),
}).annotate({ identifier: "ProjectUpdateMetadataInput" })
export type UpdateMetadataInput = typeof UpdateMetadataInput.Type

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Project.NotFoundError", {
  projectID: ID,
}) {}

export interface Resolved {
  readonly previous?: ID
  readonly id: ID
  readonly directory: AbsolutePath
  readonly vcs?: Vcs
}

type Row = typeof ProjectTable.$inferSelect

const fromRow = (row: Row): Info => {
  const icon =
    row.icon_url || row.icon_url_override || row.icon_color
      ? {
          url: row.icon_url ?? undefined,
          override: row.icon_url_override ?? undefined,
          color: row.icon_color ?? undefined,
        }
      : undefined
  return {
    id: row.id,
    worktree: row.worktree,
    vcs: row.vcs ? Schema.decodeUnknownSync(ProjectSchemaPublic.Vcs)(row.vcs) : undefined,
    name: row.name ?? undefined,
    icon,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      initialized: row.time_initialized ?? undefined,
    },
    sandboxes: row.sandboxes,
    commands: row.commands ?? undefined,
  }
}

export interface Interface {
  readonly directories: (input: DirectoriesInput) => Effect.Effect<Directories>
  readonly resolve: (input: AbsolutePath) => Effect.Effect<Resolved>
  /**
   * Temporary bridge method for writing the resolved project ID to the repo-local cache.
   *
   * This exists while the old opencode project service and this core project
   * service work together: core resolves the ID, while the old service still owns
   * database migration and persistence. The old service should call this after it
   * finishes migrating from `resolve().previous` to `resolve().id`; once project
   * persistence moves into core, this separate bridge method can go away.
   */
  readonly commit: (input: { store: AbsolutePath; id: ID }) => Effect.Effect<void>
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  readonly updateMetadata: (input: UpdateMetadataInput) => Effect.Effect<Info, NotFoundError>
  readonly preferenceGet: (id: ID) => Effect.Effect<ProjectPreference.Value>
  readonly preferencePatch: (input: {
    readonly projectID: ID
    readonly patch: ProjectPreference.Patch
    readonly expectedRevision?: number
  }) => Effect.Effect<ProjectPreference.Value, ProjectPreference.Conflict | ProjectPreference.ProjectNotFound>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProjectV2") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const projectDirectories = yield* ProjectDirectories.Service
    const { db } = yield* Database.Service

    const directories = Effect.fn("Project.directories")(function* (input: DirectoriesInput) {
      return yield* projectDirectories.list(input.projectID)
    })

    const cached = Effect.fnUntraced(function* (dir: string) {
      return yield* fs.readFileString(path.join(dir, "opencode")).pipe(
        Effect.map((value) => value.trim()),
        Effect.map((value) => (value ? ID.make(value) : undefined)),
        Effect.catch(() => Effect.succeed(undefined)),
      )
    })

    const remote = Effect.fnUntraced(function* (repo: Git.Repository) {
      const origin = yield* git.remote.get(repo)
      if (!origin) return undefined
      const normalized = url(origin)
      if (!normalized) return undefined
      return ID.make(Hash.fast(`git-remote:${normalized}`))
    })

    function url(input: string) {
      const value = input.trim()
      if (!value) return undefined

      try {
        const parsed = new URL(value)
        if (parsed.protocol === "file:") return undefined
        return parts(parsed.hostname, parsed.pathname)
      } catch {
        const scp = value.match(/^([^@/:]+@)?([^/:]+):(.+)$/)
        if (scp) return parts(scp[2], scp[3])
        return undefined
      }
    }

    function parts(host: string, name: string) {
      const pathname = name
        .replace(/^\/+/, "")
        .replace(/\.git\/?$/, "")
        .replace(/\/+$/, "")
      if (!host || !pathname) return undefined
      return `${host.toLowerCase()}/${pathname}`
    }

    const root = Effect.fnUntraced(function* (repo: Git.Repository) {
      const root = (yield* git.history.rootCommits(repo))[0]
      return root ? ID.make(root) : undefined
    })

    const resolve = Effect.fn("Project.resolve")(function* (input: AbsolutePath) {
      const repo = yield* git.repo.discover(input)
      if (!repo) return { id: ID.global, directory: AbsolutePath.make(path.parse(input).root), vcs: undefined }

      const previous = yield* cached(repo.commonDirectory)
      const id = (yield* remote(repo)) ?? previous ?? (yield* root(repo))
      return {
        previous,
        id: id ?? ID.global,
        directory: repo.worktree,
        vcs: { type: "git" as const, store: repo.commonDirectory },
      }
    })

    const commit = Effect.fn("Project.commit")(function* (input: { store: AbsolutePath; id: ID }) {
      yield* fs.writeFileString(path.join(input.store, "opencode"), input.id).pipe(Effect.ignore)
    })

    const list = Effect.fn("Project.list")(function* () {
      return (yield* db.select().from(ProjectTable).all().pipe(Effect.orDie)).map(fromRow)
    })

    const get = Effect.fn("Project.get")(function* (id: ID) {
      const row = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get().pipe(Effect.orDie)
      return row ? fromRow(row) : undefined
    })

    const updateMetadata = Effect.fn("Project.updateMetadata")(function* (input: UpdateMetadataInput) {
      const result = yield* db
        .update(ProjectTable)
        .set({
          name: input.name,
          icon_url: input.icon?.url,
          icon_url_override: input.icon?.override,
          icon_color: input.icon?.color,
          commands: input.commands,
          time_updated: Date.now(),
        })
        .where(eq(ProjectTable.id, input.projectID))
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!result) return yield* new NotFoundError({ projectID: input.projectID })
      return fromRow(result)
    })

    const preferenceGet = Effect.fn("Project.preferenceGet")(function* (id: ID) {
      return yield* ProjectPreference.get(db, id)
    })

    const preferencePatch = Effect.fn("Project.preferencePatch")(function* (input: {
      readonly projectID: ID
      readonly patch: ProjectPreference.Patch
      readonly expectedRevision?: number
    }) {
      return yield* ProjectPreference.patch(db, {
        projectID: input.projectID,
        patch: input.patch,
        expectedRevision: input.expectedRevision,
        now: Date.now(),
      })
    })

    return Service.of({
      directories,
      resolve,
      commit,
      list,
      get,
      updateMetadata,
      preferenceGet,
      preferencePatch,
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Git.node, ProjectDirectories.node, Database.node],
})
