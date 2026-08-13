import { Flag } from "@opencode-ai/core/flag/flag"
import { Effect } from "effect"
import path from "path"

const preserveExerciseGlobalRoot = !!process.env.OPENCODE_HTTPAPI_EXERCISE_GLOBAL
export const exerciseGlobalRoot =
  process.env.OPENCODE_HTTPAPI_EXERCISE_GLOBAL ??
  path.join(process.env.TMPDIR ?? "/tmp", `opencode-httpapi-global-${process.pid}`)
process.env.XDG_DATA_HOME = path.join(exerciseGlobalRoot, "data")
process.env.XDG_CONFIG_HOME = path.join(exerciseGlobalRoot, "config")
process.env.XDG_STATE_HOME = path.join(exerciseGlobalRoot, "state")
process.env.XDG_CACHE_HOME = path.join(exerciseGlobalRoot, "cache")
process.env.OPENCODE_DISABLE_SHARE = "true"

/**
 * Make this harness's own 500s readable.
 *
 * The httpapi error middleware already logs the real Cause of every defect-500
 * (`Effect.logError("failed", { ref, error, cause })`), but core's observability layer
 * installs ONLY a file logger unless OPENCODE_PRINT_LOGS is set -- it builds with
 * `Logger.layer(..., { mergeWithExisting: false })`, which replaces the console logger
 * rather than adding to it. So the cause was never lost, only written somewhere nobody
 * reading exercise output would look, and a failing scenario showed
 * `{"name":"UnknownError","ref":"err_xxxxxxxx"}` and nothing else. That cost a full
 * diagnosis assignment on TKT-323, where the answer was one line
 * (`Unbound layer node: @opencode/InstanceBootstrap`).
 *
 * Error level only, so the added output is one line per defect and nothing else. A green
 * effect-mode run currently prints exactly four, from the integration scenarios that
 * deliberately assert 500 (`Key method not found`, `OAuth method not found`, and two
 * `OAuth attempt not found`) -- those routes raise plain Errors rather than returning a
 * typed 404, which this makes visible rather than causes. Both variables are overridable
 * for a noisier local run.
 */
process.env.OPENCODE_PRINT_LOGS ??= "1"
process.env.OPENCODE_LOG_LEVEL ??= "ERROR"
export const exerciseConfigDirectory = path.join(exerciseGlobalRoot, "config", "opencode")
export const exerciseDataDirectory = path.join(exerciseGlobalRoot, "data", "opencode")

const preserveExerciseDatabase = !!process.env.OPENCODE_HTTPAPI_EXERCISE_DB
export const exerciseDatabasePath =
  process.env.OPENCODE_HTTPAPI_EXERCISE_DB ??
  path.join(process.env.TMPDIR ?? "/tmp", `opencode-httpapi-exercise-${process.pid}.db`)
process.env.OPENCODE_DB = exerciseDatabasePath
Flag.OPENCODE_DB = exerciseDatabasePath

export const original = {
  OPENCODE_SERVER_PASSWORD: Flag.OPENCODE_SERVER_PASSWORD,
  OPENCODE_SERVER_USERNAME: Flag.OPENCODE_SERVER_USERNAME,
}

export const cleanupExercisePaths = Effect.promise(async () => {
  const fs = await import("fs/promises")
  if (!preserveExerciseDatabase) {
    await Promise.all(
      [exerciseDatabasePath, `${exerciseDatabasePath}-wal`, `${exerciseDatabasePath}-shm`].map((file) =>
        fs.rm(file, { force: true }).catch(() => undefined),
      ),
    )
  }
  if (!preserveExerciseGlobalRoot)
    await fs.rm(exerciseGlobalRoot, { recursive: true, force: true }).catch(() => undefined)
})
