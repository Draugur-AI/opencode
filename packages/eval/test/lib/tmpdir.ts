import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** A fresh scratch directory per call -- one Database file per test/run, never shared. */
export const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "opencode-eval-"))
