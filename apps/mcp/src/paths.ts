// Where this worker is mounted.
//
// The Kweli MCP is a CONSUMER surface, so it lives on the consumer domain:
// `kweli.mukoko.com/mcp`. It is deliberately not on `nyuchi.dev` — that host
// carries internal tooling only. Because the worker therefore owns a path
// prefix rather than a whole hostname, nothing in it may assume it sits at the
// origin root: every route and every self-referential URL (the OAuth redirect
// URI above all) has to be built from the mount point.
//
// The mount point is an environment variable, not a literal, for the same
// reason every WorkOS value here is: a dedicated-hostname deployment or a
// staging mount would otherwise need a source change.
const DEFAULT_MCP_BASE_PATH = "/mcp";

/**
 * The worker's mount point as an absolute path with no trailing slash
 * (e.g. `/mcp`). The MCP JSON-RPC endpoint is exactly this path; every other
 * route hangs off it (`/mcp/authorize`, `/mcp/callback`, `/mcp/health`, …).
 */
export function mcpBasePath(env: Pick<Env, "MCP_BASE_PATH">): string {
  const raw = (env.MCP_BASE_PATH || "").trim() || DEFAULT_MCP_BASE_PATH;
  const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;
  // Trimmed by slicing rather than /\/+$/ — the value comes from configuration,
  // and a backtracking-prone pattern over external input is a finding whether
  // or not this particular source is trusted.
  let trimmed = withLeadingSlash;
  while (trimmed.endsWith("/")) trimmed = trimmed.slice(0, -1);
  // A root mount would make the MCP endpoint indistinguishable from every
  // other route, so fall back rather than accept it.
  return trimmed || DEFAULT_MCP_BASE_PATH;
}
