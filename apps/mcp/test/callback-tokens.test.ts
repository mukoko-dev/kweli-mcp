// /callback must verify — never just decode — the tokens from the AuthKit
// token exchange: signature, `iss` bound to the configured AuthKit issuer,
// the ID token's `aud` bound to WORKOS_CLIENT_ID, and expiry. Fail closed.
import * as jose from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireAuthkitDomain } from "../src/authkit-handler";
import { verifyCallbackTokens } from "../src/callback-tokens";

const CLIENT_ID = "client_test_kweli";

async function setup(configured: string) {
  const { publicKey, privateKey } = await jose.generateKeyPair("RS256");
  const jwk = { ...(await jose.exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  const fetched: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    fetched.push(String(input instanceof Request ? input.url : input));
    return new Response(JSON.stringify({ keys: [jwk] }), {
      headers: { "content-type": "application/json" },
    });
  });
  const issuer = requireAuthkitDomain({ WORKOS_ISSUER: configured });
  // Built exactly as /callback builds it.
  const jwks = jose.createRemoteJWKSet(new URL("/oauth2/jwks", issuer));
  const sign = (
    claims: {
      iss?: string;
      aud?: string | null;
      exp?: string | number;
      extra?: jose.JWTPayload;
    } = {},
    key: jose.CryptoKey | Uint8Array = privateKey,
  ) => {
    const jwt = new jose.SignJWT({
      email: "user@example.test",
      ...claims.extra,
    })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(claims.iss ?? issuer)
      .setSubject("user_01")
      .setIssuedAt()
      .setExpirationTime(claims.exp ?? "5m");
    if (claims.aud !== null) jwt.setAudience(claims.aud ?? CLIENT_ID);
    return jwt.sign(key);
  };
  const access = (extra: Parameters<typeof sign>[0] = {}) =>
    sign({
      aud: null,
      extra: { org_id: "org_1", scope: "openid kweli:use" },
      ...extra,
    });
  return { issuer, jwks, sign, access, fetched };
}

const expected = (issuer: string) => ({ issuer, clientId: CLIENT_ID });

describe("verifyCallbackTokens", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts tokens signed by the tenant, from our issuer, for our client", async () => {
    const { issuer, jwks, sign, access, fetched } = await setup(
      "https://id-a.example.test",
    );
    const claims = await verifyCallbackTokens(
      { idToken: await sign(), accessToken: await access() },
      jwks,
      expected(issuer),
    );
    expect(claims.id.sub).toBe("user_01");
    expect(claims.id.email).toBe("user@example.test");
    expect(claims.access.org_id).toBe("org_1");
    expect(fetched).toEqual(["https://id-a.example.test/oauth2/jwks"]);
  });

  it("rejects an ID token from the wrong issuer", async () => {
    const { issuer, jwks, sign, access } = await setup(
      "https://id-b.example.test",
    );
    for (const iss of [
      "https://evil.example.test",
      "https://id-b.example.test.evil.test",
      "https://id-b.example.test/",
    ]) {
      await expect(
        verifyCallbackTokens(
          { idToken: await sign({ iss }), accessToken: await access() },
          jwks,
          expected(issuer),
        ),
      ).rejects.toThrow();
    }
  });

  it("rejects an ID token minted for another client", async () => {
    const { issuer, jwks, sign, access } = await setup(
      "https://id-c.example.test",
    );
    await expect(
      verifyCallbackTokens(
        {
          idToken: await sign({ aud: "client_someone_else" }),
          accessToken: await access(),
        },
        jwks,
        expected(issuer),
      ),
    ).rejects.toThrow();
  });

  it("rejects an expired ID token", async () => {
    const { issuer, jwks, sign, access } = await setup(
      "https://id-d.example.test",
    );
    const past = Math.floor(Date.now() / 1000) - 3600;
    await expect(
      verifyCallbackTokens(
        { idToken: await sign({ exp: past }), accessToken: await access() },
        jwks,
        expected(issuer),
      ),
    ).rejects.toThrow();
  });

  it("rejects an ID token signed by a key outside the tenant's JWKS", async () => {
    const { issuer, jwks, sign, access } = await setup(
      "https://id-e.example.test",
    );
    const other = await jose.generateKeyPair("RS256");
    await expect(
      verifyCallbackTokens(
        {
          idToken: await sign({}, other.privateKey),
          accessToken: await access(),
        },
        jwks,
        expected(issuer),
      ),
    ).rejects.toThrow();
  });

  it("rejects an access token that is forged, from the wrong issuer or expired", async () => {
    const { issuer, jwks, sign, access } = await setup(
      "https://id-f.example.test",
    );
    const other = await jose.generateKeyPair("RS256");
    const past = Math.floor(Date.now() / 1000) - 3600;
    const forged = await new jose.SignJWT({ org_id: "org_1" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(issuer)
      .setExpirationTime("5m")
      .sign(other.privateKey);
    for (const accessToken of [
      forged,
      await access({ iss: "https://evil.example.test" }),
      await access({ exp: past }),
      "not-a-jwt",
    ]) {
      await expect(
        verifyCallbackTokens(
          { idToken: await sign(), accessToken },
          jwks,
          expected(issuer),
        ),
      ).rejects.toThrow();
    }
  });

  it("fails closed when a token is missing or the client ID is not configured", async () => {
    const { issuer, jwks, sign, access } = await setup(
      "https://id-g.example.test",
    );
    await expect(
      verifyCallbackTokens(
        { idToken: undefined, accessToken: await access() },
        jwks,
        expected(issuer),
      ),
    ).rejects.toThrow("no id token");
    await expect(
      verifyCallbackTokens(
        { idToken: await sign(), accessToken: "" },
        jwks,
        expected(issuer),
      ),
    ).rejects.toThrow("no access token");
    for (const clientId of [undefined, "", "  "]) {
      await expect(
        verifyCallbackTokens(
          { idToken: await sign(), accessToken: await access() },
          jwks,
          { issuer, clientId },
        ),
      ).rejects.toThrow("WORKOS_CLIENT_ID is not configured");
    }
  });
});
