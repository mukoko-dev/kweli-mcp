// A stand-in WorkOS environment for tests.
//
// The M2M auth path — the gate on every agent's public POST /tasks — was
// entirely untested, because testing it appeared to require a real WorkOS
// tenant, real credentials, and network access. It doesn't. WorkOS is an
// RS256 issuer publishing a JWKS at a URL; anything that behaves the same way
// is indistinguishable to `verify.ts`, which pins only signature, issuer,
// audience and org.
//
// So this generates a real keypair, serves a real JWKS, and signs real
// tokens. Nothing is mocked at the crypto layer — `jwtVerify` does its full
// job. The only substitution is `fetch`, so JWKS and token requests resolve
// here instead of over the network.
//
// That means these tests catch the failures that actually matter: a wrong
// audience, a foreign signing key, an expired token, a missing org claim.

import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from "jose";

export const FAKE_DOMAIN = "https://identity.test";

export interface TokenClaims {
  aud?: string | string[];
  iss?: string;
  org_id?: string;
  sub?: string;
  /** Seconds from now. Negative mints an already-expired token. */
  expiresInSeconds?: number;
}

export interface FakeIssuer {
  domain: string;
  /** Sign a token as this issuer. Defaults produce a valid, current token. */
  sign(claims?: TokenClaims): Promise<string>;
  /** The JWKS this issuer publishes. */
  jwks(): Promise<{ keys: unknown[] }>;
  /** Requests this issuer's fetch stub has seen. */
  readonly tokenRequests: { url: string; body: Record<string, string> }[];
  /** How many times the JWKS endpoint was hit — proves caching works. */
  readonly jwksHits: () => number;
}

export async function createFakeIssuer(
  domain: string = FAKE_DOMAIN,
  defaultAudience = "client_test",
): Promise<FakeIssuer> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(publicKey as CryptoKey);
  publicJwk.kid = "test-key-1";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";

  let jwksHits = 0;
  const tokenRequests: { url: string; body: Record<string, string> }[] = [];

  return {
    domain,
    tokenRequests,
    jwksHits: () => jwksHits,

    async jwks() {
      jwksHits++;
      return { keys: [publicJwk] };
    },

    async sign(claims: TokenClaims = {}) {
      const now = Math.floor(Date.now() / 1000);
      const expiresIn = claims.expiresInSeconds ?? 3600;

      const jwt = new SignJWT({
        ...(claims.org_id ? { org_id: claims.org_id } : {}),
      })
        .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
        .setIssuer(claims.iss ?? domain)
        .setAudience(claims.aud ?? defaultAudience)
        .setSubject(claims.sub ?? "user_test")
        .setIssuedAt(now)
        .setExpirationTime(now + expiresIn);

      return jwt.sign(privateKey as CryptoKey);
    },
  };
}

export interface StubOptions {
  /** Response for POST {domain}/oauth2/token. Omit for a default success. */
  tokenResponse?: { status: number; body: unknown };
}

/**
 * Route JWKS and token requests to the fake issuer.
 *
 * Returns a restore function. Anything not addressed to the issuer's domain
 * throws rather than silently falling through — a test that unexpectedly
 * reaches the network should fail loudly, not pass by accident.
 */
export function stubIssuerFetch(issuer: FakeIssuer, options: StubOptions = {}): () => void {
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (url === `${issuer.domain}/oauth2/jwks`) {
      return new Response(JSON.stringify(await issuer.jwks()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url === `${issuer.domain}/oauth2/token`) {
      const raw = (init?.body as URLSearchParams | undefined)?.toString() ?? "";
      issuer.tokenRequests.push({
        url,
        body: Object.fromEntries(new URLSearchParams(raw)),
      });

      const configured = options.tokenResponse;
      if (configured) {
        return new Response(JSON.stringify(configured.body), { status: configured.status });
      }
      return new Response(
        JSON.stringify({ access_token: await issuer.sign(), expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    throw new Error(`unexpected network call in test: ${url}`);
  }) as typeof fetch;

  return () => {
    globalThis.fetch = original;
  };
}

/** Build a request carrying a bearer token, as an agent's /tasks would receive. */
export function bearerRequest(token: string | null, url = "https://agent.test/tasks"): Request {
  return new Request(url, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}
