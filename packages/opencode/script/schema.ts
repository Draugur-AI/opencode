#!/usr/bin/env bun

import { generateEffect } from "@/config/schema"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { TuiConfig } from "@opencode-ai/tui/config"

const configFile = process.argv[2]
const tuiFile = process.argv[3]

console.log(configFile)
await Bun.write(configFile, JSON.stringify(generateEffect(ConfigV1.Info), null, 2))

if (tuiFile) {
  console.log(tuiFile)
  await Bun.write(tuiFile, JSON.stringify(generateEffect(TuiConfig.Info), null, 2))
}
