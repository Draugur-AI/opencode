import { createSignal, type Accessor } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { createMcpClient, isServiceUnavailableError } from "@/utils/mcp-client"
import type { McpConfigTargetReadResult } from "@/utils/mcp-client"

export type McpServerFormMode = "add" | "edit"

/**
 * A named credential slot rendered as one row: `environment.<key>` or `headers.<key>`.
 * `existing` distinguishes a slot already on disk (shown with a "leave blank to keep unchanged"
 * placeholder, never prefilled with the real value -- readTarget never returns one) from a slot
 * the user is adding fresh in this session (must be given a value to be written at all).
 *
 * Scope cut, deliberate: oauth.client_secret editing is not in this first cut. Configuring an
 * OAuth-authenticated remote MCP server through this form isn't supported yet -- environment
 * (local) and headers (remote) cover the common case this ticket's urgency is about. No secret-
 * loss risk either way (the field simply isn't editable here yet); a fast-follow, not a gap in
 * this change's own correctness.
 */
export type CredentialRow = {
  readonly field: "environment" | "headers"
  readonly key: string
  readonly existing: boolean
  value: string
  remove: boolean
}

export type McpServerFormState = {
  readonly mode: McpServerFormMode
  readonly name: Accessor<string>
  readonly setName: (value: string) => void
  readonly nameLocked: Accessor<boolean>
  readonly type: Accessor<"local" | "remote">
  readonly setType: (value: "local" | "remote") => void
  readonly command: Accessor<string>
  readonly setCommand: (value: string) => void
  readonly cwd: Accessor<string>
  readonly setCwd: (value: string) => void
  readonly url: Accessor<string>
  readonly setUrl: (value: string) => void
  readonly disabled: Accessor<boolean>
  readonly setDisabled: (value: boolean) => void
  readonly credentials: Accessor<CredentialRow[]>
  readonly addCredential: () => void
  readonly setCredentialKey: (index: number, key: string) => void
  readonly setCredentialValue: (index: number, value: string) => void
  readonly toggleCredentialRemove: (index: number) => void
  readonly removeCredentialRow: (index: number) => void
  readonly busy: Accessor<boolean>
  readonly error: Accessor<string | undefined>
  readonly load: () => Promise<void>
  readonly submit: () => Promise<boolean>
}

const credentialFieldFor = (type: "local" | "remote"): "environment" | "headers" =>
  type === "local" ? "environment" : "headers"

export function createMcpServerFormController(opts: {
  mode: McpServerFormMode
  serverName?: string
  target: Accessor<string | undefined>
  directory: Accessor<string | undefined>
  onSaved: () => void
}): McpServerFormState {
  const sdk = useServerSDK()
  const language = useLanguage()
  const client = () => createMcpClient(sdk().server)

  const [name, setName] = createSignal(opts.serverName ?? "")
  const [type, setType] = createSignal<"local" | "remote">("local")
  const [command, setCommand] = createSignal("")
  const [cwd, setCwd] = createSignal("")
  const [url, setUrl] = createSignal("")
  const [disabled, setDisabled] = createSignal(false)
  const [credentials, setCredentials] = createSignal<CredentialRow[]>([])
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const locationInput = () => {
    const dir = opts.directory()
    return dir ? { location: { directory: dir } } : undefined
  }

  const load = async () => {
    if (opts.mode !== "edit" || !opts.serverName) return
    const targetID = opts.target()
    if (!targetID) return
    setBusy(true)
    setError(undefined)
    try {
      const read: McpConfigTargetReadResult = await client().configDocument.targetRead({
        targetID,
        ...locationInput(),
      })
      const parsed = read.data.parsed as { mcp?: { servers?: Record<string, unknown> } } | undefined
      const server = parsed?.mcp?.servers?.[opts.serverName] as Record<string, unknown> | undefined
      if (!server) return
      const serverType = server.type === "remote" ? "remote" : "local"
      setType(serverType)
      if (serverType === "local") {
        setCommand(Array.isArray(server.command) ? server.command.join(" ") : "")
        setCwd(typeof server.cwd === "string" ? server.cwd : "")
      } else {
        setUrl(typeof server.url === "string" ? server.url : "")
      }
      setDisabled(server.disabled === true)
      const field = credentialFieldFor(serverType)
      const existingCredentials = server[field]
      if (existingCredentials && typeof existingCredentials === "object") {
        setCredentials(
          Object.keys(existingCredentials as object).map((key) => ({
            field,
            key,
            existing: true,
            value: "",
            remove: false,
          })),
        )
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const addCredential = () => {
    setCredentials((rows) => [...rows, { field: credentialFieldFor(type()), key: "", existing: false, value: "", remove: false }])
  }
  const setCredentialKey = (index: number, key: string) => {
    setCredentials((rows) => rows.map((row, i) => (i === index ? { ...row, key } : row)))
  }
  const setCredentialValue = (index: number, value: string) => {
    setCredentials((rows) => rows.map((row, i) => (i === index ? { ...row, value } : row)))
  }
  const toggleCredentialRemove = (index: number) => {
    setCredentials((rows) => rows.map((row, i) => (i === index ? { ...row, remove: !row.remove } : row)))
  }
  const removeCredentialRow = (index: number) => {
    setCredentials((rows) => rows.filter((_, i) => i !== index))
  }

  const submit = async (): Promise<boolean> => {
    const targetID = opts.target()
    const trimmedName = name().trim()
    if (!targetID || !trimmedName) {
      setError(language.t("settings.mcp.error.nameRequired"))
      return false
    }
    setBusy(true)
    setError(undefined)
    try {
      let hash = (
        await client().configDocument.targetRead({ targetID, ...locationInput() })
      ).data.hash

      const currentType = type()
      const value =
        currentType === "local"
          ? {
              type: "local" as const,
              command: command()
                .split(/\s+/)
                .map((part) => part.trim())
                .filter(Boolean),
              ...(cwd().trim() ? { cwd: cwd().trim() } : {}),
              ...(disabled() ? { disabled: true } : {}),
            }
          : {
              type: "remote" as const,
              url: url().trim(),
              ...(disabled() ? { disabled: true } : {}),
            }

      const applied = await client().configDocument.targetApply({
        targetID,
        expectedHash: hash,
        ...locationInput(),
        patch: { op: "mcp.server.set", name: trimmedName, value },
      })
      hash = applied.data.hash

      for (const row of credentials()) {
        if (row.remove) {
          if (!row.existing) continue
          const removed = await client().configDocument.targetApply({
            targetID,
            expectedHash: hash,
            ...locationInput(),
            patch: { op: "mcp.server.credential.remove", name: trimmedName, key: { field: row.field, key: row.key } },
          })
          hash = removed.data.hash
          continue
        }
        // A blank value on an EXISTING credential means "leave unchanged" -- never write anything,
        // since we have no real value to write and readTarget never gave us one. A blank value on
        // a NEW row means the user opened a credential slot and never filled it in -- also skip,
        // rather than writing an empty-string secret nobody asked for.
        if (!row.value) continue
        if (!row.key.trim()) continue
        const set = await client().configDocument.targetApply({
          targetID,
          expectedHash: hash,
          ...locationInput(),
          patch: {
            op: "mcp.server.credential.set",
            name: trimmedName,
            key: { field: row.field, key: row.key.trim() },
            value: row.value,
          },
        })
        hash = set.data.hash
      }

      opts.onSaved()
      return true
    } catch (cause) {
      if (isServiceUnavailableError(cause)) {
        setError(language.t("settings.mcp.error.unavailable"))
        return false
      }
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setBusy(false)
    }
  }

  return {
    mode: opts.mode,
    name,
    setName,
    nameLocked: () => opts.mode === "edit",
    type,
    setType,
    command,
    setCommand,
    cwd,
    setCwd,
    url,
    setUrl,
    disabled,
    setDisabled,
    credentials,
    addCredential,
    setCredentialKey,
    setCredentialValue,
    toggleCredentialRemove,
    removeCredentialRow,
    busy,
    error,
    load,
    submit,
  }
}
