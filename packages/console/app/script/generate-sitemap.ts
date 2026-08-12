#!/usr/bin/env bun
import { writeFile } from "fs/promises"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { config } from "../src/config.js"
import { LOCALES, route } from "../src/lib/language.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE_URL = config.baseUrl
const PUBLIC_DIR = join(__dirname, "../public")

interface SitemapEntry {
  url: string
  priority: number
  changefreq: string
}

async function getMainRoutes(): Promise<SitemapEntry[]> {
  const routes: SitemapEntry[] = []

  // Add main static routes
  const staticRoutes = [
    { path: "/", priority: 1.0, changefreq: "daily" },
    { path: "/enterprise", priority: 0.8, changefreq: "weekly" },
    { path: "/brand", priority: 0.6, changefreq: "monthly" },
    { path: "/go", priority: 0.8, changefreq: "weekly" },
  ]

  for (const item of staticRoutes) {
    for (const locale of LOCALES) {
      routes.push({
        url: `${BASE_URL}${route(locale, item.path)}`,
        priority: item.priority,
        changefreq: item.changefreq,
      })
    }
  }

  // /docs is a single stub page now (TKT-396), not a site of per-article pages -- one entry, not
  // the per-mdx-file, per-locale enumeration this used to generate. Not looped over LOCALES like
  // the routes above: route()'s /docs branch passes the path through unchanged regardless of
  // locale (the stub serves identical content either way), so looping would emit N identical
  // duplicate <url> entries for the same address.
  routes.push({ url: `${BASE_URL}/docs`, priority: 0.5, changefreq: "monthly" })

  return routes
}

function generateSitemapXML(entries: SitemapEntry[]): string {
  const urls = entries
    .map(
      (entry) => `  <url>
    <loc>${entry.url}</loc>
    <changefreq>${entry.changefreq}</changefreq>
    <priority>${entry.priority}</priority>
  </url>`,
    )
    .join("\n")

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`
}

async function main() {
  console.log("Generating sitemap...")

  const allRoutes = await getMainRoutes()

  console.log(`Total: ${allRoutes.length} routes`)

  const xml = generateSitemapXML(allRoutes)

  const outputPath = join(PUBLIC_DIR, "sitemap.xml")
  await writeFile(outputPath, xml, "utf-8")

  console.log(`✓ Sitemap generated at ${outputPath}`)
}

void main()
