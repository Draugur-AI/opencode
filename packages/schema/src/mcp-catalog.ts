export * as McpCatalog from "./mcp-catalog"

import { Schema } from "effect"
import { ConfigDocument } from "./config-document"

// Chunk 1 (TKT-323) has no live MCP runtime to query -- see the config-document module's
// RestartImpact doc. "configured"/"disabled" are the only states this catalog can honestly
// report from static config alone. Chunk 2 adds a core McpRuntime service tag (implemented as a
// layer supplied by packages/opencode, which can reach the live connection) and extends this
// status union to the full connected/pending/failed/needs_auth/needs_client_registration
// vocabulary -- never claim a live status this module cannot observe.
export const Status = Schema.Literals(["configured", "disabled"])
export type Status = typeof Status.Type

export class Entry extends Schema.Class<Entry>("Mcp.Catalog.Entry")({
  name: Schema.String,
  transport: Schema.Literals(["local", "remote"]),
  status: Status,
  /** The config-document target this server is declared in, so a client can jump straight to
   * editing it. */
  target: ConfigDocument.TargetID,
}) {}
