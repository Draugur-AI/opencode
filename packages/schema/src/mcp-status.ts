export * as McpStatus from "./mcp-status"

import { Schema } from "effect"

// Relocated from packages/opencode/src/mcp/index.ts (TKT-323 chunk 2) so packages/protocol can
// declare a response schema against it -- protocol cannot depend on opencode. packages/opencode's
// own Status re-exports this module (same pattern as ConfigMCP's core re-export), so the live
// MCP.Service there is not asked to change its own vocabulary for this.
const Connected = Schema.Struct({ status: Schema.Literal("connected") }).annotate({
  identifier: "MCPStatusConnected",
})
const Disabled = Schema.Struct({ status: Schema.Literal("disabled") }).annotate({
  identifier: "MCPStatusDisabled",
})
const Failed = Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String }).annotate({
  identifier: "MCPStatusFailed",
})
const NeedsAuth = Schema.Struct({ status: Schema.Literal("needs_auth") }).annotate({
  identifier: "MCPStatusNeedsAuth",
})
const NeedsClientRegistration = Schema.Struct({
  status: Schema.Literal("needs_client_registration"),
  error: Schema.String,
}).annotate({ identifier: "MCPStatusNeedsClientRegistration" })

export const Status = Schema.Union([
  Connected,
  Disabled,
  Failed,
  NeedsAuth,
  NeedsClientRegistration,
]).annotate({ identifier: "MCPStatus", discriminator: "status" })
export type Status = Schema.Schema.Type<typeof Status>
