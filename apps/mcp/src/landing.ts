// Minimal landing page served at `/`. The MCP surface itself lives at `/mcp`
// behind the WorkOS gate; this is just a human-facing marker.
export function landingHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Kweli MCP</title>
    <style>
      :root { color-scheme: light dark; }
      body { font: 16px/1.6 system-ui, sans-serif; max-width: 42rem; margin: 4rem auto; padding: 0 1.25rem; }
      code { background: rgba(127,127,127,0.15); padding: 0.1rem 0.35rem; border-radius: 0.25rem; }
      .muted { opacity: 0.7; }
    </style>
  </head>
  <body>
    <h1>Kweli MCP</h1>
    <p>Mukoko Kweli's agent-facing MCP — the trust graph (places, organizations,
      verification) and place generation (bulk region seeding, single named-place
      requests) in one server. Generation tools enqueue work on independent agents
      (bulk-place-agent, single-place-agent) any Nyuchi/Mukoko app can also call
      directly.</p>
    <p>The Model Context Protocol endpoint is at <code>/mcp</code>, gated by WorkOS
      AuthKit — for the platform team and org members only.</p>
    <p class="muted">© Nyuchi Web Services</p>
  </body>
</html>`;
}
