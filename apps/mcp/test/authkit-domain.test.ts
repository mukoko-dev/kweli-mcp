import { describe, expect, it } from "vitest";
import {
  AUTHKIT_DOMAIN_MISSING,
  authkitDomain,
  requireAuthkitDomain,
} from "../src/authkit-handler";

// The sign-in flow's AuthKit issuer: configuration only, parsed into an https
// origin. Unset or unusable is null, which the /authorize and /callback guard
// turns into a 503.

describe("authkitDomain", () => {
  it("is null when WORKOS_ISSUER and WORKOS_AUTHKIT_DOMAIN are unset or blank", () => {
    expect(authkitDomain({})).toBeNull();
    expect(authkitDomain({ WORKOS_ISSUER: "  " })).toBeNull();
    expect(() => requireAuthkitDomain({})).toThrow(AUTHKIT_DOMAIN_MISSING);
  });

  it("returns the configured https origin unchanged", () => {
    expect(authkitDomain({ WORKOS_ISSUER: "https://auth.example.test" })).toBe(
      "https://auth.example.test",
    );
  });

  it("accepts a bare host or an https origin, in any case, and drops any path", () => {
    expect(authkitDomain({ WORKOS_AUTHKIT_DOMAIN: "auth.example.test" })).toBe(
      "https://auth.example.test",
    );
    expect(authkitDomain({ WORKOS_ISSUER: "HTTPS://Auth.Example.Test/" })).toBe(
      "https://auth.example.test",
    );
    expect(
      authkitDomain({ WORKOS_ISSUER: "https://auth.example.test/x?y=1#z" }),
    ).toBe("https://auth.example.test");
  });

  it("prefers WORKOS_ISSUER over the legacy WORKOS_AUTHKIT_DOMAIN", () => {
    expect(
      authkitDomain({
        WORKOS_ISSUER: "a.example.test",
        WORKOS_AUTHKIT_DOMAIN: "b.example.test",
      }),
    ).toBe("https://a.example.test");
  });

  it("treats anything that is not an https origin as unconfigured", () => {
    for (const bad of [
      "http://auth.example.test",
      "javascript://auth.example.test",
      "https://user:pass@auth.example.test",
      "user@auth.example.test",
      "https://",
    ]) {
      expect(authkitDomain({ WORKOS_ISSUER: bad }), bad).toBeNull();
      expect(() => requireAuthkitDomain({ WORKOS_ISSUER: bad })).toThrow(
        AUTHKIT_DOMAIN_MISSING,
      );
    }
  });
});
