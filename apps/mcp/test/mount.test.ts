import { describe, expect, it } from "vitest";
import { createKweliAuthkitHandler } from "../src/authkit-handler";
import { mcpBasePath } from "../src/paths";

// The Kweli MCP shares kweli.mukoko.com with the Kweli Next.js app, owning only
// the `/mcp*` prefix. Nothing in the worker may assume it is at the origin
// root — the failure mode is silent, not a 404: `/callback` at the root is a
// real route belonging to a DIFFERENT WorkOS OAuth client.

describe("mcpBasePath", () => {
  it("defaults to the consumer mount", () => {
    expect(mcpBasePath({})).toBe("/mcp");
    expect(mcpBasePath({ MCP_BASE_PATH: "" })).toBe("/mcp");
    expect(mcpBasePath({ MCP_BASE_PATH: "   " })).toBe("/mcp");
  });

  it("normalizes a configured mount to a leading-slash, no-trailing-slash path", () => {
    expect(mcpBasePath({ MCP_BASE_PATH: "kweli-mcp" })).toBe("/kweli-mcp");
    expect(mcpBasePath({ MCP_BASE_PATH: "/mcp/" })).toBe("/mcp");
    expect(mcpBasePath({ MCP_BASE_PATH: "/staging/mcp//" })).toBe("/staging/mcp");
  });

  it("refuses a root mount", () => {
    // At "/" the MCP endpoint would be indistinguishable from every other
    // route, so the default stands rather than silently taking the origin.
    expect(mcpBasePath({ MCP_BASE_PATH: "/" })).toBe("/mcp");
  });
});

describe("the non-MCP surface is mounted under the base path", () => {
  const handler = createKweliAuthkitHandler("/mcp");
  const env = { MCP_BASE_PATH: "/mcp" } as unknown as Env;
  const get = (path: string) =>
    handler.fetch(new Request(`https://kweli.mukoko.com${path}`), env);

  it("serves health at the mounted path", async () => {
    const res = await get("/mcp/health");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ worker: "kweli-mcp", status: "ok" });
  });

  it("claims nothing at the origin root", async () => {
    // Each of these is served by the Kweli web app on this hostname; answering
    // them here would mean the worker had been routed too broadly.
    for (const path of ["/health", "/callback", "/authorize", "/icon.svg", "/"]) {
      expect((await get(path)).status, path).toBe(404);
    }
  });

  it("advertises the mounted endpoint on the landing page", async () => {
    // The landing sits ON the mount point; index.ts hands a browser's
    // `Accept: text/html` GET here instead of to the token-gated MCP handler.
    const res = await get("/mcp");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<code>/mcp</code>");
  });
});
