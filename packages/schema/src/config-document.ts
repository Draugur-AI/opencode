export * as ConfigDocument from "./config-document"

import { Schema } from "effect"
import { ConfigMCP } from "./config-mcp"

export const TargetKind = Schema.Literals(["global", "project"])
export type TargetKind = typeof TargetKind.Type

export const TargetID = Schema.String.pipe(Schema.brand("Config.Document.TargetID"))
export type TargetID = typeof TargetID.Type

export class TargetSummary extends Schema.Class<TargetSummary>("Config.Document.TargetSummary")({
  id: TargetID,
  kind: TargetKind,
  path: Schema.String,
  exists: Schema.Boolean,
}) {}

export class Diagnostic extends Schema.Class<Diagnostic>("Config.Document.Diagnostic")({
  severity: Schema.Literals(["error", "warning"]),
  message: Schema.String,
  offset: Schema.optional(Schema.Int),
  length: Schema.optional(Schema.Int),
}) {}

export class ReadResult extends Schema.Class<ReadResult>("Config.Document.ReadResult")({
  target: TargetSummary,
  text: Schema.String,
  hash: Schema.String,
  parsed: Schema.Unknown,
  diagnostics: Schema.Array(Diagnostic),
}) {}

// Chunk 1 is honest about what it cannot know yet: applying an MCP server patch always requires
// at minimum a reconnect, and this module has no live MCP runtime to perform one (see TKT-323
// chunk 2). Reporting "restart" is deliberately conservative rather than claiming a "live" effect
// this module cannot produce -- never show a green state for a change that only exists on disk.
export const RestartImpact = Schema.Literals(["live", "reopen", "restart"])
export type RestartImpact = typeof RestartImpact.Type

export class ProvenanceField extends Schema.Class<ProvenanceField>("Config.Document.ProvenanceField")({
  value: Schema.Unknown,
  source: TargetID,
}) {}

export class EffectiveResult extends Schema.Class<EffectiveResult>("Config.Document.EffectiveResult")({
  fields: Schema.Record(Schema.String, ProvenanceField),
}) {}

// Allowlisted and typed -- deliberately NOT a general JSON Patch / jq-style path, so a client can
// never touch a field outside what this module has explicitly reviewed for safety (e.g. never a
// raw filesystem path, never an arbitrary nested key). Each catalog that becomes editable through
// this module adds its own variants here as that chunk lands (TKT-323 chunk 2: skills/plugins,
// chunk 3: profiles/data) -- chunk 1 only needs MCP server set/remove.
export const Patch = Schema.Union([
  Schema.Struct({ op: Schema.Literal("mcp.server.set"), name: Schema.String, value: ConfigMCP.Server }),
  Schema.Struct({ op: Schema.Literal("mcp.server.remove"), name: Schema.String }),
])
export type Patch = typeof Patch.Type

export class ValidateResult extends Schema.Class<ValidateResult>("Config.Document.ValidateResult")({
  diagnostics: Schema.Array(Diagnostic),
  preview: EffectiveResult,
}) {}

export class ApplyResult extends Schema.Class<ApplyResult>("Config.Document.ApplyResult")({
  hash: Schema.String,
  restartImpact: RestartImpact,
}) {}
