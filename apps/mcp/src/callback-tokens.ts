import * as jose from "jose";

/**
 * Verify the tokens `/callback` receives from the AuthKit token exchange.
 *
 * Both are trusted for decisions — the ID token names the user, the access
 * token carries the org and the permissions the org/permission gates check —
 * so neither is merely decoded. Fail closed on any mismatch:
 *
 * - ID token: signature against the AuthKit JWKS, `iss` exactly the configured
 *   AuthKit issuer (WorkOS issues `iss` = `https://<authkit domain>`), `aud`
 *   exactly `WORKOS_CLIENT_ID` (the client this flow signs in to), and expiry.
 * - Access token: signature against the same JWKS, the same `iss`, and expiry.
 *   Its `aud` is not bound: it is the token the MCP hands on to WorkOS-backed
 *   APIs, not an assertion addressed to this client.
 */

export interface CallbackClaims {
  id: jose.JWTPayload & {
    email?: unknown;
    name?: unknown;
    given_name?: unknown;
    family_name?: unknown;
  };
  access: jose.JWTPayload & {
    permissions?: string[];
    org_id?: string;
    scope?: string;
  };
}

export async function verifyCallbackTokens(
  tokens: { idToken: string | undefined; accessToken: string | undefined },
  jwks: jose.JWTVerifyGetKey,
  expected: { issuer: string; clientId: string | undefined },
): Promise<CallbackClaims> {
  const issuer = expected.issuer;
  const clientId = expected.clientId?.trim();
  // An empty binding would switch the claim check off rather than fail it.
  if (!issuer)
    throw new Error("callback token verification: no issuer configured");
  if (!clientId) {
    throw new Error(
      "callback token verification: WORKOS_CLIENT_ID is not configured",
    );
  }
  if (!tokens.idToken)
    throw new Error("callback token verification: no id token returned");
  if (!tokens.accessToken) {
    throw new Error("callback token verification: no access token returned");
  }
  const id = await jose.jwtVerify(tokens.idToken, jwks, {
    issuer,
    audience: clientId,
  });
  const access = await jose.jwtVerify(tokens.accessToken, jwks, { issuer });
  return {
    id: id.payload as CallbackClaims["id"],
    access: access.payload as CallbackClaims["access"],
  };
}
