// WorkOS M2M (machine-to-machine) auth — the CALLER side. Any Nyuchi/Mukoko
// app that wants to call an agent's public `POST /tasks` (bulk-place-agent,
// single-place-agent) mints its own client_credentials token here, using
// that agent's own dedicated client_id/secret pair (stored in the calling
// app's own secrets — never shared inline with other credentials). Pair with
// `verify.ts` on the agent side.

export interface MintConfig {
  authkitDomain: string; // e.g. https://your-env.authkit.app (no trailing slash)
  clientId: string;
  clientSecret: string;
  organizationId?: string; // pin the grant to a specific org (bulk-place-agent's check)
}

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

// Keyed by clientId — safe to share across requests within one Worker
// isolate; a fresh isolate just re-mints on first use.
const tokenCache = new Map<string, CachedToken>();

// Refresh this many seconds before actual expiry, so a token never gets used
// right at the edge of validity.
const EXPIRY_SKEW_SECONDS = 30;

export async function fetchM2MToken(cfg: MintConfig): Promise<string> {
  const cached = tokenCache.get(cfg.clientId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
  if (cfg.organizationId) body.set("organization_id", cfg.organizationId);

  const resp = await fetch(`${cfg.authkitDomain}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!resp.ok) {
    throw new Error(`fetchM2MToken: WorkOS token endpoint returned ${resp.status}`);
  }
  const data = (await resp.json()) as { access_token: string; expires_in: number };

  tokenCache.set(cfg.clientId, {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(0, data.expires_in - EXPIRY_SKEW_SECONDS) * 1000,
  });
  return data.access_token;
}
