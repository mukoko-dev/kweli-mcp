// Minimal landing page served at `/`. The MCP surface itself lives at `/mcp`
// behind the WorkOS gate; this is just a human-facing marker.
export function landingHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Fundi — place ingestion</title>
    <style>
      :root { color-scheme: light dark; }
      body { font: 16px/1.6 system-ui, sans-serif; max-width: 42rem; margin: 4rem auto; padding: 0 1.25rem; }
      code { background: rgba(127,127,127,0.15); padding: 0.1rem 0.35rem; border-radius: 0.25rem; }
      .muted { opacity: 0.7; }
    </style>
  </head>
  <body>
    <h1>Fundi</h1>
    <p>Agentic ingestion worker for the Mukoko platform. It turns regions into
      clean, sovereign, <strong>tier-0</strong> place and entity records.</p>
    <p>The Model Context Protocol endpoint is at <code>/mcp</code>, gated by WorkOS
      AuthKit — for the platform team only.</p>
    <p class="muted">© Nyuchi Web Services</p>
  </body>
</html>`;
}
