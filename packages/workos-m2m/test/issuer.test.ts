// normaliseAuthkitDomain: parse, never concatenate. It must never guess a
// host, and must never let anything but an https origin through.

import { describe, expect, it } from "vitest";

import { normaliseAuthkitDomain } from "../src/issuer";

describe("normaliseAuthkitDomain", () => {
  it("fails closed when the value is unset or blank", () => {
    expect(() => normaliseAuthkitDomain(undefined)).toThrow(
      "WORKOS_ISSUER is not configured",
    );
    expect(() => normaliseAuthkitDomain("   ")).toThrow(
      "WORKOS_ISSUER is not configured",
    );
  });

  it("names the setting it was given", () => {
    expect(() => normaliseAuthkitDomain("", "WORKOS_AUTHKIT_DOMAIN")).toThrow(
      "WORKOS_AUTHKIT_DOMAIN is not configured",
    );
  });

  it("accepts a bare host or an https origin, and returns the origin", () => {
    expect(normaliseAuthkitDomain("https://auth.example.test")).toBe(
      "https://auth.example.test",
    );
    expect(normaliseAuthkitDomain("auth.example.test")).toBe(
      "https://auth.example.test",
    );
    expect(normaliseAuthkitDomain("https://auth.example.test/")).toBe(
      "https://auth.example.test",
    );
    expect(normaliseAuthkitDomain("HTTPS://Auth.Example.Test")).toBe(
      "https://auth.example.test",
    );
  });

  it("drops any path, query or fragment", () => {
    expect(normaliseAuthkitDomain("https://auth.example.test/x/y?z=1#f")).toBe(
      "https://auth.example.test",
    );
  });

  it("rejects anything that is not an https origin", () => {
    for (const bad of [
      "http://auth.example.test",
      "javascript://auth.example.test",
      "https://user:pass@auth.example.test",
      "user@auth.example.test",
      "https://",
    ]) {
      expect(() => normaliseAuthkitDomain(bad), bad).toThrow(
        "WORKOS_ISSUER is not configured",
      );
    }
  });
});
