// WorkOS M2M (machine-to-machine) auth — the AGENT side. Any Nyuchi/Mukoko
// app (including the Kweli MCP itself) authenticates with the
// client_credentials grant: exchange a client_id/secret at
// https://<authkit_domain>/oauth2/token for a short-lived JWT, then send it
// as `Authorization: Bearer <jwt>`. This module verifies that JWT statelessly
// against the environment JWKS — no OAuth redirect, no session KV. Pair with
// `mint.ts` on the calling side.
//
// Verification (per WorkOS docs):
//   • signature  — https://<authkit_domain>/oauth2/jwks (cached by jose)
//   • iss        — https://<authkit_domain>
//   • aud        — this agent's own M2M application client id
//   • org_id     — optional allowlist; omit to accept any org (e.g.
//                  single-place-agent intentionally has no org restriction,
//                  while bulk-place-agent does)

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export interface M2MConfig {
  authkitDomain: string; // e.g. https://your-env.authkit.app (no trailing slash)
  audience: string[]; // allowed `aud` — this agent's own M2M app client id(s)
  allowedOrgIds?: string[];
}

// Non-regex trailing-slash strip (avoids a polynomial-regex ReDoS surface).
function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* "/" */) end--;
  return s.slice(0, end);
}

export function m2mConfig(env: {
  WORKOS_ISSUER?: string;
  WORKOS_AUTHKIT_DOMAIN?: string;
  WORKOS_M2M_CLIENT_ID?: string;
  WORKOS_ALLOWED_ORG_IDS?: string;
}): M2MConfig | null {
  // `WORKOS_ISSUER` is the standard name going forward — the same concept is
  // spelled WORKOS_AUTHKIT_DOMAIN / WORKOS_ISSUER / WORKOS_AUTHORIZATION_SERVER
  // / AUTHKIT_DOMAIN across the estate, and that inconsistency is what made the
  // Aug 2026 issuer migration a per-service hunt. Accept both, prefer the new.
  const trimmed = (env.WORKOS_ISSUER || env.WORKOS_AUTHKIT_DOMAIN)?.trim();
  const authkitDomain = trimmed ? stripTrailingSlashes(trimmed) : undefined;
  const audience = (env.WORKOS_M2M_CLIENT_ID ?? "")
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
      "WWW-Authenticate": 'Bearer realm="tasks", error="invalid_token"',
    },
  });
}
