export * as SkillCatalog from "./skill-catalog"

import path from "path"
import { Context, Effect, Layer } from "effect"
import { SkillCatalog as SkillCatalogSchema } from "@opencode-ai/schema/skill-catalog"
import type { ConfigDocument as ConfigDocumentSchema } from "@opencode-ai/schema/config-document"
import { makeLocationNode } from "./effect/app-node"
import { ConfigDocument } from "./config/document"
import { SkillV2 } from "./skill"

export const Entry = SkillCatalogSchema.Entry
export type Entry = SkillCatalogSchema.Entry

export interface Interface {
  /** Every skill this location knows about -- winners AND shadowed losers, with provenance and
   * (for directory sources) an enclosing config target. Consumes `SkillV2.Service.entries()`
   * directly rather than re-deriving its own load-then-merge walk: this catalog reports what
   * `SkillV2.list()` decides, it never decides on its own (lead ruling, TKT-323 diary 2554,
   * "truth flows runtime -> catalog, never the reverse"). */
  readonly list: () => Effect.Effect<Entry[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SkillCatalog") {}

// The deepest target whose OWN directory encloses (or equals) `sourceDirectory` -- "deepest"
// because a project tier nested inside another project tier must win over the outer one, same
// "closer overrides farther" rule `mergeSkills` itself resolves collisions with. Falls back to
// the global target, which structurally encloses every location: a directory source with no
// project-tier target above it (e.g. a bare `.opencode` folder with no co-located opencode.json,
// walked past by `ConfigDocument.listTargets()`'s own chunk-1 scope -- see that method's doc
// comment) still has SOME enclosing config, and reporting undefined there would be a client-
// visible regression from "attributed to global" to "attributed to nothing" for a case that was
// never really ambiguous.
function findEnclosingTarget(
  sourceDirectory: string,
  targets: readonly ConfigDocumentSchema.TargetSummary[],
): ConfigDocumentSchema.TargetSummary | undefined {
  let best: ConfigDocumentSchema.TargetSummary | undefined
  let bestDepth = -1
  for (const target of targets) {
    const targetDirectory = path.dirname(target.path)
    const relative = path.relative(targetDirectory, sourceDirectory)
    const encloses = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
    if (!encloses) continue
    const depth = targetDirectory.split(path.sep).length
    if (depth > bestDepth) {
      best = target
      bestDepth = depth
    }
  }
  return best ?? targets.find((target) => target.kind === "global")
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skills = yield* SkillV2.Service
    const documents = yield* ConfigDocument.Service

    const list: Interface["list"] = Effect.fn("SkillCatalog.list")(function* () {
      const merged = yield* skills.entries()
      const targets = yield* documents.listTargets()

      return merged.map(
        (entry) =>
          new Entry({
            skill: entry.skill,
            source: entry.source,
            sourceIndex: entry.sourceIndex,
            shadowedBy: entry.shadowedBy,
            target:
              entry.source.type === "directory" ? findEnclosingTarget(entry.source.path, targets)?.id : undefined,
          }),
      )
    })

    return Service.of({ list })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [SkillV2.node, ConfigDocument.node] })
