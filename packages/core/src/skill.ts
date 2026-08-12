export * as SkillV2 from "./skill"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { Context, Effect, Layer, Schema, Types } from "effect"
import { Skill } from "@opencode-ai/schema/skill"
import { AgentV2 } from "./agent"
import { ConfigMarkdown } from "./config/markdown"
import { FSUtil } from "./fs-util"
import { PermissionV2 } from "./permission"
import { AbsolutePath } from "./schema"
import { SkillDiscovery } from "./skill/discovery"
import { State } from "./state"

export const DirectorySource = Skill.DirectorySource
export type DirectorySource = Skill.DirectorySource

export const UrlSource = Skill.UrlSource
export type UrlSource = Skill.UrlSource

export const EmbeddedSource = Skill.EmbeddedSource
export type EmbeddedSource = Skill.EmbeddedSource

export const Source = Skill.Source
export type Source = typeof Source.Type

export const Info = Skill.Info
export type Info = Skill.Info

export const available = (skills: ReadonlyArray<Info>, agent: AgentV2.Info) =>
  skills.filter((skill) => PermissionV2.evaluate("skill", skill.name, agent.permissions).effect !== "deny")

const Frontmatter = Schema.Struct({
  name: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  slash: Schema.Boolean.pipe(Schema.optional),
})
const decodeFrontmatter = Schema.decodeUnknownOption(Frontmatter)

export type Data = {
  sources: Types.DeepMutable<Source>[]
}

export type Draft = {
  source: (source: Source) => void
  list: () => readonly Source[]
}

export interface Interface extends State.Transformable<Draft> {
  readonly sources: () => Effect.Effect<Source[]>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Skill") {}

export type LoadedSource = { readonly source: Source; readonly skills: readonly Info[] }

export type MergeEntry = {
  readonly skill: Info
  readonly source: Source
  readonly sourceIndex: number
  /** The source (later in `loaded`'s order, i.e. registered later / closer-wins) that shadows
   * this one, if any. Undefined means this is the effective (winning) skill for this name. */
  readonly shadowedBy?: { readonly source: Source; readonly sourceIndex: number }
}

/**
 * Pure so the catalog (TKT-323 SkillCatalog) and this module's own runtime resolution cannot
 * disagree about which skill wins a name collision: both consume this exact function rather than
 * each deriving their own ordering that "should" match the other's (lead ruling, TKT-323 diary
 * 2554 follow-up, 2026-08-12 -- "truth flows runtime -> catalog, never the reverse"; a report
 * surface must never be a second, independently-derived source of truth for a runtime mechanism).
 * `list()` below delegates to this unchanged in behavior -- same last-write-wins-by-name Map
 * semantics as before this extraction, just re-derived from this function's full entry list
 * instead of computed inline, so `list()`'s own consumers see no behavior change.
 *
 * `loaded` must be in the SAME registration order `state.get().sources` produces it in, which is
 * itself `Config.Service.entries()`'s global-then-closer-project-then-`.opencode`-dirs order
 * (`config/plugin/skill.ts`) -- later index wins, matching "closer overrides farther."
 */
export const mergeSkills = (loaded: readonly LoadedSource[]): MergeEntry[] => {
  const winnerIndexByName = new Map<string, number>()
  loaded.forEach(({ skills }, sourceIndex) => {
    for (const skill of skills) winnerIndexByName.set(skill.name, sourceIndex)
  })
  const entries: MergeEntry[] = []
  loaded.forEach(({ source, skills }, sourceIndex) => {
    for (const skill of skills) {
      const winnerIndex = winnerIndexByName.get(skill.name)!
      entries.push(
        winnerIndex === sourceIndex
          ? { skill, source, sourceIndex }
          : { skill, source, sourceIndex, shadowedBy: { source: loaded[winnerIndex]!.source, sourceIndex: winnerIndex } },
      )
    }
  })
  return entries
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* SkillDiscovery.Service
    const fs = yield* FSUtil.Service

    const state = State.create<Data, Draft>({
      initial: () => ({ sources: [] }),
      draft: (draft) => ({
        source: (source) => {
          if (draft.sources.some((item) => Source.equals(item, source))) return
          draft.sources.push(source as Types.DeepMutable<Source>)
        },
        list: () => draft.sources as Source[],
      }),
    })

    const load = Effect.fn("SkillV2.load")(function* (source: Source) {
      const skills: Info[] = []
      if (source.type === "embedded") return [source.skill]
      const directories = source.type === "directory" ? [source.path] : yield* discovery.pull(source.url)
      for (const directory of directories) {
        const files = yield* fs
          .glob("{*.md,**/SKILL.md}", { cwd: directory, absolute: true, include: "file", symlink: true, dot: true })
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
        for (const filepath of files.toSorted()) {
          const content = yield* fs.readFileStringSafe(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!content) continue
          const markdown = ConfigMarkdown.parseOption(content)
          if (!markdown) continue
          const frontmatter = decodeFrontmatter(markdown.data).valueOrUndefined
          if (!frontmatter) continue
          const name =
            frontmatter.name !== undefined
              ? frontmatter.name
              : path.dirname(filepath) === directory
                ? path.basename(filepath, ".md")
                : undefined
          if (!name) continue
          skills.push({
            name,
            description: frontmatter.description,
            slash: frontmatter.slash,
            location: AbsolutePath.make(filepath),
            content: markdown.content,
          })
        }
      }
      return skills
    })

    // QUESTION(Dax): Should local skill sources invalidate on filesystem watch
    // events, following the reload policy chosen for other context sources?
    const cache = new Map<string, Info[]>()
    const list = Effect.fn("SkillV2.list")(function* () {
      const loaded: LoadedSource[] = []
      for (const source of state.get().sources) {
        const key = Source.key(source)
        const skills = cache.get(key) ?? (yield* load(source))
        cache.set(key, skills)
        loaded.push({ source, skills })
      }
      return mergeSkills(loaded)
        .filter((entry) => !entry.shadowedBy)
        .map((entry) => entry.skill)
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      sources: Effect.fn("SkillV2.sources")(function* () {
        return state.get().sources
      }),
      list,
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [SkillDiscovery.node, FSUtil.node] })
