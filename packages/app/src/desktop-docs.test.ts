import { describe, expect, test } from "bun:test"
import { desktopDocsUrl } from "./desktop-docs"

describe("desktopDocsUrl", () => {
  test("derives /docs on the connected server's own origin", () => {
    expect(desktopDocsUrl("http://127.0.0.1:4096")).toBe("http://127.0.0.1:4096/docs")
  })

  test("drops the URL when no server is connected, rather than guessing", () => {
    expect(desktopDocsUrl(undefined)).toBeUndefined()
  })
})
