import { describe, expect, test } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"

/**
 * TKT-318: `session_transcript_search` (packages/core/src/database/migration/
 * 20260810170000_session_transcript_search.ts) is an FTS5 virtual table, not a bounded LIKE scan.
 * The build post's spec is explicit that this choice is CONDITIONAL: "FTS5 only if all supported
 * binaries guarantee it -- otherwise a bounded per-session scan with the limit explicit."
 *
 * This is that guarantee, made permanent rather than asserted once in a PR description.
 *
 * There is only ONE sqlite driver actually reachable in this fork's shipped product: checked
 * packages/core/package.json's `#sqlite` conditional export --
 *   { "bun": "./sqlite.bun.ts", "node": "./sqlite.node.ts", "default": "./sqlite.bun.ts" }
 * -- and confirmed empirically that Bun 1.3.14 cannot even resolve a bare `import "node:sqlite"`
 * (attempted in this same test file; got "Could not resolve: node:sqlite"). Dev, the test suite,
 * and the standalone binary (`packages/opencode/script/build.ts --single`, which is `bun build
 * --compile` under the hood) all run under Bun exclusively, so `sqlite.node.ts` is unreachable
 * dead code for this product today -- there is nothing there to probe.
 *
 * So the actual guarantee this test makes permanent is narrower and stronger than "both drivers":
 * bun:sqlite's FTS5 support, on whatever platform runs this suite. Combined with CI's test.yml
 * unit job matrix running on both ubuntu-latest and windows-latest (FORK.md divergence-ledger row
 * for that workflow), this probe actually executes on every platform the fork ships for. If a
 * future platform's bundled SQLite ever drops FTS5, this goes red instead of search silently
 * returning nothing.
 *
 * Also verified manually (see TKT-318 diary): `bun build --compile` -- the exact mechanism the
 * standalone binary uses -- preserves this same bun:sqlite FTS5 support, confirmed by compiling
 * and running this exact probe as a standalone binary on linux/aarch64. FTS5 is a Bun-runtime-
 * level build property (baked into every bun:sqlite regardless of app-level bundling), not
 * something the app's own build step could selectively disable.
 */
describe("FTS5 availability (session_transcript_search's load-bearing assumption)", () => {
  test("bun:sqlite has FTS5 compiled in and a virtual table round-trips", () => {
    const db = new BunDatabase(":memory:")
    const compileOptions = db.query("PRAGMA compile_options").all() as { compile_options: string }[]
    expect(compileOptions.some((option) => option.compile_options === "ENABLE_FTS5")).toBe(true)

    db.run("CREATE VIRTUAL TABLE t USING fts5(body)")
    db.run("INSERT INTO t (body) VALUES ('the quick brown fox')")
    const match = db.query("SELECT body FROM t WHERE t MATCH 'quick'").get() as { body: string } | null
    expect(match?.body).toBe("the quick brown fox")
  })
})
