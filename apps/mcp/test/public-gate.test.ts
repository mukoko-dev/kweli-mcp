import { describe, expect, it } from "vitest";
import {
  decideAnonymous,
  isAuthServerMetadataPath,
  PUBLIC_TOOLS,
  protectedResourceMetadata,
  signInRequired,
  withMountIssuer,
} from "../src/public-gate";

// Split by tool (owner decision 2026-10-07): the graph reads stay open, and a
// gated tool called without a token answers the 401 that makes an MCP client
// sign in and retry.

const call = (name: string, id = 1) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: {} },
  });

describe("decideAnonymous", () => {
  it("serves the public reads and the protocol's own methods without sign-in", () => {
    for (const tool of PUBLIC_TOOLS)
      expect(decideAnonymous(call(tool))).toEqual({ kind: "anonymous" });
    for (const method of [
      "initialize",
      "tools/list",
      "ping",
      "notifications/initialized",
    ]) {
      expect(
        decideAnonymous(JSON.stringify({ jsonrpc: "2.0", id: 1, method })),
      ).toEqual({ kind: "anonymous" });
    }
  });

  it("asks for sign-in for generation and internal tools", () => {
    for (const tool of [
      "seed_region",
      "seed_admin_bulk",
      "request_place",
      "task_status",
      "list_recent_places",
    ]) {
      expect(decideAnonymous(call(tool))).toEqual({ kind: "sign_in", tool });
    }
  });

  it("gates a tool nobody has declared public (allowlist, not blocklist)", () => {
    expect(decideAnonymous(call("a_tool_added_next_month"))).toEqual({
      kind: "sign_in",
      tool: "a_tool_added_next_month",
    });
  });

  it("gates a batch if any call in it is gated", () => {
    const batch = `[${call("search_places", 1)},${call("seed_region", 2)}]`;
    expect(decideAnonymous(batch)).toEqual({
      kind: "sign_in",
      tool: "seed_region",
    });
  });

  it("keeps the Next.js MCP's legacy names callable by rewriting them", () => {
    const d = decideAnonymous(call("search_venues"));
    expect(d.kind).toBe("anonymous");
    const body = JSON.parse((d as { body: string }).body);
    expect(body.params.name).toBe("search_places");
    const v = JSON.parse(
      (decideAnonymous(call("get_venue")) as { body: string }).body,
    );
    expect(v.params.name).toBe("get_place");
  });

  it("forwards a body that is not JSON untouched, for the transport to reject", () => {
    expect(decideAnonymous("not json")).toEqual({ kind: "anonymous" });
  });
});

describe("the sign-in signal and discovery", () => {
  const origin = "https://kweli.mukoko.com";

  it("answers 401 with an RFC 9728 pointer at this worker's own metadata", async () => {
    const res = signInRequired(origin, "/mcp", "seed_region");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://kweli.mukoko.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("names the mount, not the origin, as the authorization server", async () => {
    const body = (await protectedResourceMetadata(origin, "/mcp").json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(body.resource).toBe("https://kweli.mukoko.com/mcp");
    // The origin's own metadata is the web app's and points at WorkOS.
    expect(body.authorization_servers).toEqual([
      "https://kweli.mukoko.com/mcp",
    ]);
    expect(
      withMountIssuer(
        { issuer: origin, token_endpoint: `${origin}/mcp/token` },
        origin,
        "/mcp",
      ),
    ).toEqual({
      issuer: "https://kweli.mukoko.com/mcp",
      token_endpoint: "https://kweli.mukoko.com/mcp/token",
    });
  });

  it("recognises the discovery paths clients try for an issuer with a path", () => {
    for (const p of [
      "/.well-known/oauth-authorization-server/mcp",
      "/.well-known/openid-configuration/mcp",
      "/mcp/.well-known/oauth-authorization-server",
      "/mcp/.well-known/openid-configuration",
    ]) {
      expect(isAuthServerMetadataPath(p, "/mcp")).toBe(true);
    }
    expect(
      isAuthServerMetadataPath(
        "/.well-known/oauth-authorization-server",
        "/mcp",
      ),
    ).toBe(false);
  });
});
