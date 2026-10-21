// Split by tool (owner decision 2026-10-07): the graph reads stay open under
// Mukoko's open-data policy, and sign-in is asked for only when a caller
// reaches for a tool that changes something or reads internal state.
//
// One endpoint, two doors. A request with no Authorization header is served
// anonymously, except that calling a gated tool answers HTTP 401 with an RFC
// 9728 `resource_metadata` pointer — the MCP step-up signal: the client runs
// the OAuth flow against this worker and retries with a token, which then
// goes through @cloudflare/workers-oauth-provider as before. tools/list is
// the same for both, so people can see what signing in unlocks.
//
// The open set is an ALLOWLIST: a tool added later is gated until someone
// decides it is public.

/** Tools anyone may call without signing in. */
export const PUBLIC_TOOLS: ReadonlySet<string> = new Set([
  "search_places",
  "get_place",
  "get_organization",
  "get_verification",
  "get_open_stats",
  "compute_pluscode",
]);

/**
 * Names the anonymous Next.js MCP (mukoko-dev/kweli app/mcp/route.ts)
 * accepted and this worker does not register. Kept callable so existing
 * clients survive the cutover; they are not listed.
 */
export const LEGACY_ALIASES: Readonly<Record<string, string>> = {
  search_venues: "search_places",
  get_venue: "get_place",
};

type JsonRpcMessage = {
  method?: unknown;
  params?: { name?: unknown } & Record<string, unknown>;
} & Record<string, unknown>;

export type GateDecision =
  | { kind: "anonymous"; body?: string }
  | { kind: "sign_in"; tool: string };

function isMessage(v: unknown): v is JsonRpcMessage {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Decide what an unauthenticated POST body may do. `body` in the result is
 * the (possibly alias-rewritten) body to forward; `undefined` means forward
 * the original unchanged. A body that is not JSON is forwarded as is: the MCP
 * transport answers it with its own parse error.
 */
export function decideAnonymous(raw: string): GateDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "anonymous" };
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  let rewritten = false;
  for (const m of messages) {
    if (!isMessage(m) || m.method !== "tools/call" || !m.params) continue;
    const name = m.params.name;
    if (typeof name !== "string") continue;
    const target = LEGACY_ALIASES[name];
    if (target) {
      m.params.name = target;
      rewritten = true;
    }
    const effective = target ?? name;
    if (!PUBLIC_TOOLS.has(effective))
      return { kind: "sign_in", tool: effective };
  }
  return rewritten
    ? { kind: "anonymous", body: JSON.stringify(parsed) }
    : { kind: "anonymous" };
}

/** Where this worker's RFC 9728 protected-resource metadata lives. */
export function resourceMetadataUrl(origin: string, basePath: string): string {
  return `${origin}/.well-known/oauth-protected-resource${basePath}`;
}

/** The 401 that tells an MCP client to sign in and retry. */
export function signInRequired(
  origin: string,
  basePath: string,
  tool: string,
): Response {
  return new Response(
    JSON.stringify({
      error: "invalid_token",
      error_description: `Sign in to Mukoko to use ${tool}.`,
    }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer realm="OAuth", resource_metadata="${resourceMetadataUrl(origin, basePath)}", error="invalid_token", error_description="Sign in to Mukoko to use ${tool}."`,
      },
    },
  );
}

/**
 * RFC 9728 protected-resource metadata for the MCP endpoint. The issuer is
 * the MOUNT (`https://kweli.mukoko.com/mcp`), not the origin: the origin's
 * own `/.well-known/oauth-authorization-server` belongs to the Kweli web app
 * and points at WorkOS, which would hand clients a token this worker rejects.
 */
export function protectedResourceMetadata(
  origin: string,
  basePath: string,
): Response {
  return Response.json(
    {
      resource: `${origin}${basePath}`,
      authorization_servers: [`${origin}${basePath}`],
      bearer_methods_supported: ["header"],
      resource_name: "Mukoko Kweli",
    },
    {
      headers: {
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=3600",
      },
    },
  );
}

/**
 * Discovery paths for the authorization-server metadata of an issuer with a
 * path (`/mcp`): RFC 8414 path insertion, the OIDC variants MCP clients also
 * try, and the path-appended form.
 */
export function isAuthServerMetadataPath(
  pathname: string,
  basePath: string,
): boolean {
  return [
    `/.well-known/oauth-authorization-server${basePath}`,
    `/.well-known/openid-configuration${basePath}`,
    `${basePath}/.well-known/oauth-authorization-server`,
    `${basePath}/.well-known/openid-configuration`,
  ].includes(pathname);
}

/** Give the provider's metadata the mount as its issuer (see above). */
export function withMountIssuer(
  metadata: Record<string, unknown>,
  origin: string,
  basePath: string,
) {
  return { ...metadata, issuer: `${origin}${basePath}` };
}
