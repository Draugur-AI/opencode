const stage = process.env.SST_STAGE || "dev"

export default {
  // TKT-391: this fork bundles docs into the distribution and serves them from the running
  // instance's own /docs route (astro.config.mjs's `base`) -- there is no fixed external origin
  // to name (Ethan/Sean ruling: "no external host to name"). Astro's `site` config requires a
  // syntactically valid absolute URL (not a path) for sitemap/canonical-link generation, so this
  // is a neutral placeholder rather than upstream's real domain -- accepted degradation, not a
  // bug: nobody crawls a doc bundle embedded in a compiled CLI binary.
  url: "http://localhost",
  console: stage === "production" ? "https://opencode.ai/auth" : `https://${stage}.opencode.ai/auth`,
  email: "help@anoma.ly",
  socialCard: "https://social-cards.sst.dev",
  github: "https://github.com/Draugur-AI/opencode",
  headerLinks: [
    { name: "app.header.home", url: "/" },
    { name: "app.header.docs", url: "/docs/" },
  ],
}
