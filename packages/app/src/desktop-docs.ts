// TKT-414: this build serves its own docs (TKT-391) at the connected server's own origin --
// opencode.ai/docs describes a different program. undefined (no connected server) means don't
// offer the command at all; absence over wrongness, per TKT-397/TKT-414.
export function desktopDocsUrl(serverUrl: string | undefined) {
  if (!serverUrl) return undefined
  return new URL("/docs", serverUrl).toString()
}
