import { describe, expect, it } from "vitest";
import {
  countryAt,
  countryInScope,
  IMF_ADVANCED_ECONOMIES,
} from "../src/scope";

describe("countryInScope", () => {
  it("excludes exactly the 41 IMF advanced economies", () => {
    expect(IMF_ADVANCED_ECONOMIES.size).toBe(41);
    for (const iso of ["US", "GB", "FR", "JP", "SG", "TW"])
      expect(countryInScope(iso)).toBe(false);
  });

  it("includes Africa and emerging and developing economies", () => {
    for (const iso of ["ZW", "ZA", "NG", "EG", "IN", "BR", "MX", "ID", "PL"])
      expect(countryInScope(iso)).toBe(true);
  });

  it("includes African territories of advanced economies", () => {
    expect(countryInScope("RE")).toBe(true); // Réunion
    expect(countryInScope("YT")).toBe(true); // Mayotte
  });

  it("is case-insensitive and treats an unknown country as out of scope", () => {
    expect(countryInScope("us")).toBe(false);
    expect(countryInScope("zw")).toBe(true);
    expect(countryInScope(null)).toBe(false);
    expect(countryInScope("")).toBe(false);
  });
});

describe("countryAt", () => {
  it("reads the upper-cased ISO code from Nominatim", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ address: { country_code: "ke" } }),
      )) as unknown as typeof fetch;
    await expect(
      countryAt({ endpoint: "https://n.test", fetchImpl }, -1.29, 36.82),
    ).resolves.toBe("KE");
  });

  it("returns null in open sea", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ error: "Unable to geocode" }),
      )) as unknown as typeof fetch;
    await expect(
      countryAt({ endpoint: "https://n.test", fetchImpl }, 0, -30),
    ).resolves.toBeNull();
  });
});
