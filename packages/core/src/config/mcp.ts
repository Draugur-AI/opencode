export * as ConfigMCP from "./mcp"

import { ConfigMCP as ConfigMCPSchema } from "@opencode-ai/schema/config-mcp"

export const Timeout = ConfigMCPSchema.Timeout
export type Timeout = ConfigMCPSchema.Timeout

export const Local = ConfigMCPSchema.Local
export type Local = ConfigMCPSchema.Local

export const OAuth = ConfigMCPSchema.OAuth
export type OAuth = ConfigMCPSchema.OAuth

export const Remote = ConfigMCPSchema.Remote
export type Remote = ConfigMCPSchema.Remote

export const Server = ConfigMCPSchema.Server
export type Server = ConfigMCPSchema.Server

export const Info = ConfigMCPSchema.Info
export type Info = ConfigMCPSchema.Info
