import type { APIEvent } from "@solidjs/start"
import type { DownloadPlatform } from "../types"

const prodAssetNames: Record<string, string> = {
  "darwin-aarch64-dmg": "opencode-desktop-mac-arm64.dmg",
  "darwin-x64-dmg": "opencode-desktop-mac-x64.dmg",
  "windows-x64-nsis": "opencode-desktop-win-x64.exe",
  "linux-x64-deb": "opencode-desktop-linux-amd64.deb",
  "linux-x64-appimage": "opencode-desktop-linux-x86_64.AppImage",
  "linux-x64-rpm": "opencode-desktop-linux-x86_64.rpm",
} satisfies Record<DownloadPlatform, string>

const betaAssetNames: Record<string, string> = {
  "darwin-aarch64-dmg": "opencode-desktop-mac-arm64.dmg",
  "darwin-x64-dmg": "opencode-desktop-mac-x64.dmg",
  "windows-x64-nsis": "opencode-desktop-win-x64.exe",
  "linux-x64-deb": "opencode-desktop-linux-amd64.deb",
  "linux-x64-appimage": "opencode-desktop-linux-x86_64.AppImage",
  "linux-x64-rpm": "opencode-desktop-linux-x86_64.rpm",
} satisfies Record<DownloadPlatform, string>

// Doing this on the server lets us preserve the original name for platforms we don't care to rename for
const downloadNames: Record<string, string> = {
  "darwin-aarch64-dmg": "OpenCode Desktop.dmg",
  "darwin-x64-dmg": "OpenCode Desktop.dmg",
  "windows-x64-nsis": "OpenCode Desktop Installer.exe",
} satisfies { [K in DownloadPlatform]?: string }

// Hidden (TKT-396): no Draugur release pipeline exists yet, so this never pulls anomalyco
// binaries under this fork's own domain. The asset maps above stay as reference for whenever
// a real pipeline exists; GET is disabled rather than deleted so re-enabling is one change.
export async function GET(_evt: APIEvent) {
  return new Response(null, { status: 404 })
}
