export * as ConfigMCP from "./config-mcp"

import { Schema } from "effect"
import { PositiveInt } from "./schema"

export class Timeout extends Schema.Class<Timeout>("ConfigV2.MCP.Timeout")({
  startup: PositiveInt.pipe(Schema.optional).annotate({
    description: "Maximum time in milliseconds to establish and initialize the MCP server.",
  }),
  request: PositiveInt.pipe(Schema.optional).annotate({
    description: "Maximum time in milliseconds to wait for each MCP request after initialization.",
  }),
}) {}

export class Local extends Schema.Class<Local>("ConfigV2.MCP.Local")({
  type: Schema.Literal("local"),
  command: Schema.String.pipe(Schema.Array),
  cwd: Schema.String.pipe(Schema.optional).annotate({
    description: "Working directory for the MCP server process. Relative paths resolve from the workspace directory.",
  }),
  environment: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  timeout: Timeout.pipe(Schema.optional),
}) {}

export class OAuth extends Schema.Class<OAuth>("ConfigV2.MCP.OAuth")({
  client_id: Schema.String.pipe(Schema.optional),
  client_secret: Schema.String.pipe(Schema.optional),
  scope: Schema.String.pipe(Schema.optional),
  callback_port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })).pipe(Schema.optional),
  redirect_uri: Schema.String.pipe(Schema.optional),
}) {}

export class Remote extends Schema.Class<Remote>("ConfigV2.MCP.Remote")({
  type: Schema.Literal("remote"),
  url: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
  oauth: Schema.Union([OAuth, Schema.Literal(false)]).pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  timeout: Timeout.pipe(Schema.optional),
}) {}

export const Server = Schema.Union([Local, Remote]).pipe(Schema.toTaggedUnion("type"))
export type Server = typeof Server.Type

export class Info extends Schema.Class<Info>("ConfigV2.MCP")({
  timeout: Timeout.pipe(Schema.optional),
  servers: Schema.Record(Schema.String, Server).pipe(Schema.optional),
}) {}

// The non-secret projection of `Server` -- structurally CANNOT contain `environment`, `headers`,
// or `oauth.client_secret`, on purpose (TKT-323, feedback caught before any consumer existed): a
// connection-detail edit (command, url, cwd, disabled, timeout, oauth.client_id/scope/etc.) that
// went through the full `Server` type would, under a whole-value write, silently destroy whatever
// credentials the server already had -- the client never holds their real values to round-trip
// (every read response redacts them by design, see document.ts), so it could never resubmit them
// correctly even if it tried. Making the type unable to CARRY those fields at all means a
// connection-detail patch cannot destroy what it structurally cannot mention -- this is a
// property of the type, not a discipline someone has to remember. Credential writes go through
// the separate `mcp.server.credential.set`/`.remove` field ops instead (config-document.ts),
// which write (or delete) exactly one named secret slot and never read one back.
export class LocalNonSecret extends Schema.Class<LocalNonSecret>("ConfigV2.MCP.LocalNonSecret")({
  type: Schema.Literal("local"),
  command: Schema.String.pipe(Schema.Array),
  cwd: Schema.String.pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  timeout: Timeout.pipe(Schema.optional),
}) {}

export class OAuthNonSecret extends Schema.Class<OAuthNonSecret>("ConfigV2.MCP.OAuthNonSecret")({
  client_id: Schema.String.pipe(Schema.optional),
  scope: Schema.String.pipe(Schema.optional),
  callback_port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })).pipe(Schema.optional),
  redirect_uri: Schema.String.pipe(Schema.optional),
}) {}

export class RemoteNonSecret extends Schema.Class<RemoteNonSecret>("ConfigV2.MCP.RemoteNonSecret")({
  type: Schema.Literal("remote"),
  url: Schema.String,
  oauth: Schema.Union([OAuthNonSecret, Schema.Literal(false)]).pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  timeout: Timeout.pipe(Schema.optional),
}) {}

export const ServerNonSecret = Schema.Union([LocalNonSecret, RemoteNonSecret]).pipe(Schema.toTaggedUnion("type"))
export type ServerNonSecret = typeof ServerNonSecret.Type

// Identifies exactly one secret-shaped write slot for `mcp.server.credential.set`/`.remove` --
// the SAME three locations `mcpSecretPaths` (document.ts) already enumerates for redaction, so
// the write-side allowlist and the read-side allowlist can never drift into naming different
// fields. `environment`/`headers` are open-ended records (arbitrary caller-named keys); `oauth`
// has exactly one secret field, so its variant carries no `key` -- there is nothing to name.
export const CredentialKey = Schema.Union([
  Schema.Struct({ field: Schema.Literal("environment"), key: Schema.String }),
  Schema.Struct({ field: Schema.Literal("headers"), key: Schema.String }),
  Schema.Struct({ field: Schema.Literal("oauth.client_secret") }),
])
export type CredentialKey = typeof CredentialKey.Type
