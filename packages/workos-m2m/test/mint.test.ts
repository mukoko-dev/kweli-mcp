// The caller side. Every app that calls an agent's POST /tasks goes through
// here — including the Kweli MCP, which deliberately gets no shortcut.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fetchM2MToken } from "../src/mint";
import { createFakeIssuer, stubIssuerFetch, type FakeIssuer } from "./fake-issuer";

let issuer: FakeIssuer;
let restore: () => void;
let counter = 0;

/** mint.ts caches by clientId at module scope — a fresh id per test isolates them. */
function freshClientId(): string {
  return `client_test_${counter++}`;
}

beforeEach(async () => {
  issuer = await createFakeIssuer("https://identity.test");
  restore = stubIssuerFetch(issuer);
});

afterEach(() => restore());

describe("fetchM2MToken", () => {
  it("performs a client_credentials grant with the given credentials", async () => {
    const clientId = freshClientId();
    const token = await fetchM2MToken({
      authkitDomain: issuer.domain,
      clientId,
      clientSecret: "secret_value",
    });

    expect(token).toBeTruthy();
    expect(issuer.tokenRequests).toHaveLength(1);
    expect(issuer.tokenRequests[0]!.body).toEqual({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: "secret_value",
    });
  });

  it("pins the grant to an organization when one is given", async () => {
    // This is how bulk-place-agent's org restriction is satisfied: the org
    // has to be requested at mint time, not asserted at verify time.
    await fetchM2MToken({
      authkitDomain: issuer.domain,
      clientId: freshClientId(),
      clientSecret: "s",
      organizationId: "org_nyuchi",
    });
    expect(issuer.tokenRequests[0]!.body.organization_id).toBe("org_nyuchi");
  });

  it("omits organization_id entirely when not given", async () => {
    // single-place-agent has no org restriction; sending an empty value
    // would be a different request than sending none.
    await fetchM2MToken({
      authkitDomain: issuer.domain,
      clientId: freshClientId(),
      clientSecret: "s",
    });
    expect(issuer.tokenRequests[0]!.body).not.toHaveProperty("organization_id");
  });

  it("reuses a cached token rather than minting per call", async () => {
    // Without this every tool call costs an extra WorkOS round-trip.
    const cfg = { authkitDomain: issuer.domain, clientId: freshClientId(), clientSecret: "s" };
    const first = await fetchM2MToken(cfg);
    const second = await fetchM2MToken(cfg);

    expect(second).toBe(first);
    expect(issuer.tokenRequests).toHaveLength(1);
  });

  it("keeps separate cache entries per client id", async () => {
    // The MCP holds credentials for both agents; one must never serve the
    // other, or a single-place token would be sent to bulk-place-agent.
    const a = freshClientId();
    const b = freshClientId();
    await fetchM2MToken({ authkitDomain: issuer.domain, clientId: a, clientSecret: "s" });
    await fetchM2MToken({ authkitDomain: issuer.domain, clientId: b, clientSecret: "s" });

    expect(issuer.tokenRequests.map((r) => r.body.client_id)).toEqual([a, b]);
  });

  it("re-mints once the cached token falls inside the expiry skew", async () => {
    // A token valid for 20s is already inside the 30s safety margin, so it
    // must never be served from cache — using one at the edge of validity
    // produces intermittent 401s that are miserable to diagnose.
    restore();
    restore = stubIssuerFetch(issuer, {
      tokenResponse: { status: 200, body: { access_token: "short_lived", expires_in: 20 } },
    });

    const cfg = { authkitDomain: issuer.domain, clientId: freshClientId(), clientSecret: "s" };
    await fetchM2MToken(cfg);
    await fetchM2MToken(cfg);

    expect(issuer.tokenRequests).toHaveLength(2);
  });

  it("throws with the status when WorkOS rejects the credentials", async () => {
    restore();
    restore = stubIssuerFetch(issuer, {
      tokenResponse: { status: 401, body: { error: "invalid_client" } },
    });

    await expect(
      fetchM2MToken({
        authkitDomain: issuer.domain,
        clientId: freshClientId(),
        clientSecret: "wrong",
      }),
    ).rejects.toThrow(/401/);
  });

  it("does not cache a failed mint", async () => {
    const clientId = freshClientId();
    restore();
    restore = stubIssuerFetch(issuer, { tokenResponse: { status: 500, body: {} } });

    await expect(
      fetchM2MToken({ authkitDomain: issuer.domain, clientId, clientSecret: "s" }),
    ).rejects.toThrow();

    // Recovering after an outage must not require a new isolate.
    restore();
    restore = stubIssuerFetch(issuer);
    await expect(
      fetchM2MToken({ authkitDomain: issuer.domain, clientId, clientSecret: "s" }),
    ).resolves.toBeTruthy();
  });
});
