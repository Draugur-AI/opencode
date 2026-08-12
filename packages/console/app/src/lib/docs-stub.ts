// Disabled (TKT-396): the console's own /docs previously proxied to docs.opencode.ai, an
// upstream service. Real documentation now ships inside the product itself (packages/opencode's
// compiled binary embeds and serves it at /docs on the running instance, TKT-391) -- this console
// has no in-tree deployment today, so a stub page states that truthfully rather than 404ing the
// ~30 nav links that still point here across the site.
export function docsStub(): Response {
  return new Response(
    `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Documentation</title></head>
<body>
<p>Documentation ships inside the product itself now. Run your instance and visit
<code>/docs</code> on it.</p>
</body>
</html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
  )
}
