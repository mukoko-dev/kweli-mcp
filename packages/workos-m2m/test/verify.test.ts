// The agent-side gate on every public POST /tasks. Real RS256 signatures
// verified against a real JWKS — see fake-issuer.ts for why that's possible
// without a WorkOS tenant.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { denyResponse, m2mConfig, verifyM2M } from "../src/verify";
import {
  bearerRequest,
  createFakeIssuer,
  FAKE_DOMAIN,
  stubIssuerFetch,
  type FakeIssuer,
} from "./fake-issuer";

const CLIENT_ID = "client_bulk";
const ORG_ID = "org_nyuchi";

let issuer: FakeIssuer;
let restore: () => void;

beforeEach(async () => {
  // A distinct domain per test defeats verify.ts's module-level JWKS cache,
  // which would otherwise leak one test's signing key into the next.
  issuer = await createFakeIssuer(
    `${FAKE_DOMAIN}/${Math.random().toString(36).slice(2)}`,
    CLIENT_ID,
  );
  restore = stubIssuerFetch(issuer);
});

afterEach(() => restore());

function cfg(overrides: Partial<Record<string, string>> = {}) {
  return m2mConfig({
    WORKOS_AUTHKIT_DOMAIN: issuer.domain,
    WORKOS_M2M_CLIENT_ID: CLIENT_ID,
    ...overrides,
  })!;
}

describe("m2mConfig", () => {
  it("returns null when unconfigured, so callers can 503 rather than crash", () => {
    expect(m2mConfig({})).toBeNull();
    expect(m2mConfig({ WORKOS_AUTHKIT_DOMAIN: FAKE_DOMAIN })).toBeNull();
    expect(m2mConfig({ WORKOS_M2M_CLIENT_ID: CLIENT_ID })).toBeNull();
  });

  it("strips trailing slashes so the issuer claim matches exactly", () => {
    // `iss` is compared as an exact string; a stray slash silently fails
    // every verification with a confusing "invalid token".
    const c = m2mConfig({
      WORKOS_AUTHKIT_DOMAIN: "https://identity.test///",
      WORKOS_M2M_CLIENT_ID: CLIENT_ID,
    });
    expect(c!.authkitDomain).toBe("https://identity.test");
  });

  it("accepts several audiences and org ids, comma-separated", () => {
    const c = m2mConfig({
      WORKOS_AUTHKIT_DOMAIN: FAKE_DOMAIN,
      WORKOS_M2M_CLIENT_ID: " a , b ",
      WORKOS_ALLOWED_ORG_IDS: " org_1 , org_2 ",
    });
    expect(c!.audience).toEqual(["a", "b"]);
    expect(c!.allowedOrgIds).toEqual(["org_1", "org_2"]);
  });

  it("leaves allowedOrgIds undefined when none are set", () => {
    // single-place-agent depends on this: no org restriction at all.
    expect(cfg().allowedOrgIds).toBeUndefined();
    expect(cfg({ WORKOS_ALLOWED_ORG_IDS: "  " }).allowedOrgIds).toBeUndefined();
  });
});

describe("verifyM2M — accepting a good token", () => {
  it("accepts a correctly signed, correctly addressed token", async () => {
    const result = await verifyM2M(bearerRequest(await issuer.sign()), cfg());
    expect(result.ok).toBe(true);
    expect(result.payload?.sub).toBe("user_test");
  });

  it("accepts any org when no allowlist is configured", async () => {
    const token = await issuer.sign({ org_id: "org_anything" });
    expect((await verifyM2M(bearerRequest(token), cfg())).ok).toBe(true);
  });

  it("accepts a token whose org is on the allowlist", async () => {
    const token = await issuer.sign({ org_id: ORG_ID });
    const result = await verifyM2M(
      bearerRequest(token),
      cfg({ WORKOS_ALLOWED_ORG_IDS: `other_org,${ORG_ID}` }),
    );
    expect(result.ok).toBe(true);
  });

  it("caches the JWKS instead of refetching per request", async () => {
    const c = cfg();
    await verifyM2M(bearerRequest(await issuer.sign()), c);
    await verifyM2M(bearerRequest(await issuer.sign()), c);
    await verifyM2M(bearerRequest(await issuer.sign()), c);
    expect(issuer.jwksHits()).toBe(1);
  });
});

describe("verifyM2M — rejecting a bad token", () => {
  it("rejects a missing Authorization header", async () => {
    const result = await verifyM2M(bearerRequest(null), cfg());
    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  it.each([
    ["not bearer at all", "Basic abc"],
    ["bearer with no token", "Bearer "],
    ["a bare token", "abc.def.ghi"],
  ])("rejects %s", async (_label, header) => {
    const request = new Request("https://agent.test/tasks", {
      method: "POST",
      headers: { authorization: header },
    });
    expect((await verifyM2M(request, cfg())).ok).toBe(false);
  });

  it("rejects a token signed by a different issuer", async () => {
    // The load-bearing case: anyone can mint a JWT, so the signature check
    // against *our* JWKS is the whole security boundary.
    const attacker = await createFakeIssuer(issuer.domain, CLIENT_ID);
    const forged = await attacker.sign();
    const result = await verifyM2M(bearerRequest(forged), cfg());
    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  it("rejects a token minted for a different audience", async () => {
    // Stops one agent's credential being replayed against another —
    // single-place-agent's token must not open bulk-place-agent.
    const token = await issuer.sign({ aud: "client_someone_else" });
    expect((await verifyM2M(bearerRequest(token), cfg())).ok).toBe(false);
  });

  it("rejects a token claiming a different issuer", async () => {
    const token = await issuer.sign({ iss: "https://evil.test" });
    expect((await verifyM2M(bearerRequest(token), cfg())).ok).toBe(false);
  });

  it("rejects an expired token", async () => {
    const token = await issuer.sign({ expiresInSeconds: -60 });
    expect((await verifyM2M(bearerRequest(token), cfg())).ok).toBe(false);
  });

  it("rejects a valid token whose org is not allowed — 403, not 401", async () => {
    // The distinction matters: the caller authenticated fine, they just
    // aren't permitted. 401 would wrongly suggest bad credentials.
    const token = await issuer.sign({ org_id: "org_outsider" });
    const result = await verifyM2M(
      bearerRequest(token),
      cfg({ WORKOS_ALLOWED_ORG_IDS: ORG_ID }),
    );
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("rejects a token with no org at all when an allowlist is set", async () => {
    // bulk-place-agent's guarantee: only the Nyuchi org can trigger a bulk
    // seed. A token with no org_id must not slip past the check.
    const result = await verifyM2M(
      bearerRequest(await issuer.sign()),
      cfg({ WORKOS_ALLOWED_ORG_IDS: ORG_ID }),
    );
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("never leaks verification detail to the caller", async () => {
    const token = await issuer.sign({ expiresInSeconds: -60 });
    const result = await verifyM2M(bearerRequest(token), cfg());
    expect(result.error).toBe("invalid token");
    expect(result.error).not.toContain("exp");
  });
});

describe("denyResponse", () => {
  it("carries the status and a WWW-Authenticate challenge", async () => {
    const response = denyResponse(403, "organization not allowed");
    expect(response.status).toBe(403);
    expect(response.headers.get("WWW-Authenticate")).toContain("Bearer");
    expect(await response.json()).toEqual({ error: "organization not allowed" });
  });
});

describe("issuer variable naming", () => {
  // The Aug 2026 migration had to be applied service by service partly because
  // the same value is spelled four different ways across the estate. New code
  // uses WORKOS_ISSUER; the old name still works so nothing breaks mid-rollout.
  it("prefers WORKOS_ISSUER over the legacy WORKOS_AUTHKIT_DOMAIN", () => {
    const c = m2mConfig({
      WORKOS_ISSUER: "https://accounts.mukoko.com",
      WORKOS_AUTHKIT_DOMAIN: "https://identity.nyuchi.com",
      WORKOS_M2M_CLIENT_ID: CLIENT_ID,
    });
    expect(c!.authkitDomain).toBe("https://accounts.mukoko.com");
  });

  it("still accepts the legacy name alone", () => {
    const c = m2mConfig({
      WORKOS_AUTHKIT_DOMAIN: "https://accounts.mukoko.com",
      WORKOS_M2M_CLIENT_ID: CLIENT_ID,
    });
    expect(c!.authkitDomain).toBe("https://accounts.mukoko.com");
  });
});
