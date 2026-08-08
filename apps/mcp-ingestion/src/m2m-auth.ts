// WorkOS M2M (machine-to-machine) auth. Internal, platform-team-only services
// authenticate with the client_credentials grant: a caller exchanges its
// client_id/secret at https://<authkit_domain>/oauth2/token for a short-lived
// JWT, then sends it as `Authorization: Bearer <jwt>`. We verify that JWT
// statelessly against the environment JWKS — no OAuth redirect, no session KV.
//
// Verification (per WorkOS docs):
//   • signature  — https://<authkit_domain>/oauth2/jwks (cached by jose)
//   • iss        — https://<authkit_domain>
//   • aud        — our M2M application client id(s)
//   • org_id     — optional allowlist for the granted third party

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export interface M2MConfig {
  authkitDomain: string; // e.g. https://your-env.authkit.app (no trailing slash)
  audience: string[]; // allowed `aud` — our M2M app client id(s)
  allowedOrgIds?: string[];
}

// Non-regex trailing-slash strip (avoids a polynomial-regex ReDoS surface).
function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* "/" */) end--;
  return s.slice(0, end);
}

export function m2mConfig(
  env: {
    WORKOS_AUTHKIT_DOMAIN?: string;
    WORKOS_M2M_CLIENT_ID?: string;
    WORKOS_ALLOWED_ORG_IDS?: string;
  },
  // Override the expected `aud` (comma-separated) to gate a surface against a
  // different M2M application — e.g. /mcp (internal MCP app) vs /tasks (fundi
  // agents app). Defaults to WORKOS_M2M_CLIENT_ID (the internal MCP app).
  audienceCsv?: string,
): M2MConfig | null {
  const trimmed = env.WORKOS_AUTHKIT_DOMAIN?.trim();
  const authkitDomain = trimmed ? stripTrailingSlashes(trimmed) : undefined;
  const audience = (audienceCsv ?? env.WORKOS_M2M_CLIENT_ID ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!authkitDomain || audience.length === 0) return null;
  const orgs = (env.WORKOS_ALLOWED_ORG_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { authkitDomain, audience, allowedOrgIds: orgs.length ? orgs : undefined };
}

// jose caches the keys; key the remote set by domain so a config change rebuilds it.
let jwksCache: { domain: string; jwks: ReturnType<typeof createRemoteJWKSet> } | null = null;
function getJwks(domain: string) {
  if (!jwksCache || jwksCache.domain !== domain) {
    jwksCache = { domain, jwks: createRemoteJWKSet(new URL(`${domain}/oauth2/jwks`)) };
  }
  return jwksCache.jwks;
}

export interface VerifyResult {
  ok: boolean;
  payload?: JWTPayload;
  status?: number;
  error?: string;
}

export async function verifyM2M(request: Request, cfg: M2MConfig): Promise<VerifyResult> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return { ok: false, status: 401, error: "missing bearer token" };

  try {
    const { payload } = await jwtVerify(match[1], getJwks(cfg.authkitDomain), {
      issuer: cfg.authkitDomain,
      audience: cfg.audience,
    });
    if (cfg.allowedOrgIds) {
      const org = typeof payload.org_id === "string" ? payload.org_id : undefined;
      if (!org || !cfg.allowedOrgIds.includes(org)) {
        return { ok: false, status: 403, error: "organization not allowed" };
      }
    }
    return { ok: true, payload };
  } catch (e) {
    console.error("m2m verify failed", { error: e instanceof Error ? e.message : String(e) });
    return { ok: false, status: 401, error: "invalid token" };
  }
}

export function denyResponse(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "content-type": "application/json",
      // Signals bearer auth to clients without advertising an OAuth flow.
      "WWW-Authenticate": 'Bearer realm="mcp", error="invalid_token"',
    },
  });
}
