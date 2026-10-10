import { describe, expect, it } from "vitest";
import {
  PLACES_APP_CSP,
  PLACES_APP_HTML,
  PLACES_APP_MIME,
  PLACES_APP_URI,
} from "../src/places-app";

// The places map MCP App view that hosts render for search_places results.

describe("places map view", () => {
  it("is an MCP App resource", () => {
    expect(PLACES_APP_URI.startsWith("ui://")).toBe(true);
    expect(PLACES_APP_MIME).toBe("text/html;profile=mcp-app");
    expect(PLACES_APP_HTML).toContain("<!doctype html>");
    expect(PLACES_APP_HTML).toContain("ui/initialize");
  });

  it("declares every external origin it loads in its CSP", () => {
    const origins = [
      ...PLACES_APP_HTML.matchAll(/(?:src|href)="(https:\/\/[^/"]+)/g),
    ].map((m) => m[1]);
    for (const origin of origins)
      expect(PLACES_APP_CSP.resourceDomains).toContain(origin);
  });

  it("never writes community text as HTML", () => {
    expect(PLACES_APP_HTML).not.toContain("innerHTML");
  });
});
