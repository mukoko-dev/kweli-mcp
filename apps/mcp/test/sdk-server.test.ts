// SDK-level tests for the Kweli MCP (server.ts + mcp-handler.ts).
//
// A real MCP SDK `Client` talks to the real handler over the SDK's own
// Streamable HTTP client transport, whose `fetch` is routed into the
// handler, so these tests see what any MCP client sees: tools/list, typed
// results with structuredContent, pagination and isError results. Mongo is a
// small in-memory fake injected through `createKweliMcpHandler({ mongo })`;
// the D1 ledger is a stub.

import { afterEach, describe, expect, it } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { MongoClient } from "mongodb";
import worker from "../src/index";
import { createKweliMcpHandler } from "../src/mcp-handler";
import { CHARACTER_LIMIT } from "../src/server";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type Doc = Record<string, unknown>;

function matches(doc: Doc, filter: Doc): boolean {
  for (const [key, cond] of Object.entries(filter)) {
    const value = key
      .split(".")
      .reduce<unknown>((v, k) => (v as Doc | undefined)?.[k], doc);
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      const c = cond as Doc;
      if ("$in" in c && !(c.$in as unknown[]).includes(value)) return false;
      if ("$ne" in c && value === c.$ne) return false;
      if (
        "$regex" in c &&
        !new RegExp(String(c.$regex), String(c.$options ?? "")).test(
          String(value ?? ""),
        )
      )
        return false;
      if ("$near" in c) continue;
    } else if (value !== cond) return false;
  }
  return true;
}

function fakeMongo(data: Record<string, Record<string, Doc[]>>): MongoClient {
  return {
    db: (dbName: string) => ({
      collection: (name: string) => {
        const rows = () => data[dbName]?.[name] ?? [];
        return {
          find: (
            filter: Doc,
            opts: { skip?: number; limit?: number; sort?: Doc } = {},
          ) => ({
            toArray: async () => {
              let out = rows().filter((d) => matches(d, filter));
              if (opts.sort && "name" in opts.sort)
                out = [...out].sort((a, b) =>
                  String(a.name).localeCompare(String(b.name)),
                );
              const skip = opts.skip ?? 0;
              return out.slice(
                skip,
                opts.limit ? skip + opts.limit : undefined,
              );
            },
          }),
          findOne: async (filter: Doc) =>
            rows().find((d) => matches(d, filter)) ?? null,
          countDocuments: async (filter: Doc) =>
            rows().filter((d) => matches(d, filter)).length,
          aggregate: () => ({
            toArray: async () => [{ _id: "country", count: rows().length }],
          }),
        };
      },
    }),
  } as unknown as MongoClient;
}

const PLACES = Array.from({ length: 25 }, (_, i) => ({
  _id: `place-${String(i).padStart(2, "0")}`,
  name: `Musika Market ${i}`,
  slug: `musika-${i}`,
  placeType: ["Market"],
  address: { city: i % 2 ? "Harare" : "Bulawayo" },
  geo: { type: "Point", coordinates: [31.05, -17.83] },
  bundu: { verificationTier: i % 5 },
  ownerEntityId: "org-1",
  isActive: true,
}));

const DATA = {
  places: {
    places: PLACES,
    placesGeo: [
      { _id: "zw", name: "Zimbabwe", geoType: "country", isoCode: "ZW" },
      { _id: "ke", name: "Kenya", geoType: "country", isoCode: "KE" },
      { _id: "ng", name: "Nigeria", geoType: "country", isoCode: "NG" },
    ],
  },
  entity: {
    entities: [
      {
        _id: "org-1",
        name: "Musika Traders",
        slug: "musika-traders",
        bundu: { verificationTier: 3 },
      },
    ],
  },
};

const D1_STUB = {
  prepare: () => ({
    bind: (taskId: string) => ({
      first: async () =>
        taskId === "task-1"
          ? {
              task_id: "task-1",
              status: "complete",
              places_created: 2,
              entities_created: 1,
              skipped: 0,
              notes: null,
              records: JSON.stringify([
                { placeId: "place-00", entityId: "org-1" },
                { placeId: "place-01" },
              ]),
              error: null,
              created_at: "2026-10-01T00:00:00Z",
              started_at: null,
              finished_at: null,
            }
          : null,
    }),
  }),
};

const ENV = { DB: D1_STUB, TELEMETRY_D1_DISABLED: "true" } as unknown as Env;
const CTX = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;
const handler = createKweliMcpHandler({ mongo: async () => fakeMongo(DATA) });

let client: Client | undefined;

async function connect(
  fetchImpl: (r: Request) => Promise<Response> = (r) =>
    handler.fetch(r, ENV, CTX),
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL("https://kweli.mukoko.com/mcp"),
    {
      fetch: (input, init) => fetchImpl(new Request(input, init)),
    },
  );
  client = new Client({ name: "kweli-sdk-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

afterEach(async () => {
  await client?.close();
  client = undefined;
});

const text = (r: { content: unknown }) =>
  (r.content as { text: string }[])[0]!.text;

// ---------------------------------------------------------------------------

describe("Kweli MCP through the SDK client", () => {
  it("lists 15 kweli_-prefixed tools, each with a title, all four annotations and an outputSchema", async () => {
    const { tools } = await (await connect()).listTools();
    expect(tools).toHaveLength(15);
    for (const tool of tools) {
      expect(tool.name, tool.name).toMatch(/^kweli_[a-z_]+$/);
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.description!.length, tool.name).toBeGreaterThan(60);
      expect(tool.outputSchema, tool.name).toBeDefined();
      for (const hint of [
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
      ] as const) {
        expect(typeof tool.annotations?.[hint], `${tool.name}.${hint}`).toBe(
          "boolean",
        );
      }
    }
    const seed = tools.find((t) => t.name === "kweli_seed_region")!;
    expect(seed.annotations).toMatchObject({
      readOnlyHint: false,
      openWorldHint: true,
      idempotentHint: false,
    });
  });

  it("never exposes a caller-controlled upstream endpoint", async () => {
    const { tools } = await (await connect()).listTools();
    for (const name of ["kweli_overpass_lookup", "kweli_resolve_hierarchy"]) {
      const props =
        tools.find((t) => t.name === name)!.inputSchema.properties ?? {};
      expect(Object.keys(props), name).not.toContain("endpoint");
    }
  });

  it("paginates kweli_search_places with has_more / next_offset and matching structuredContent", async () => {
    const c = await connect();
    const first = await c.callTool({
      name: "kweli_search_places",
      arguments: { query: "Musika", limit: 10 },
    });
    expect(first.isError).toBeFalsy();
    const s = first.structuredContent as {
      items: { id: string }[];
      has_more: boolean;
      next_offset: number;
    };
    expect(s.items).toHaveLength(10);
    expect(s.has_more).toBe(true);
    expect(s.next_offset).toBe(10);
    expect(JSON.parse(text(first))).toEqual(first.structuredContent);

    const last = await c.callTool({
      name: "kweli_search_places",
      arguments: { query: "Musika", limit: 10, offset: 20 },
    });
    const l = last.structuredContent as {
      items: unknown[];
      has_more: boolean;
      next_offset?: number;
    };
    expect(l.items).toHaveLength(5);
    expect(l.has_more).toBe(false);
    expect(l.next_offset).toBeUndefined();
  });

  it("gets a place, an organization and a verification tier", async () => {
    const c = await connect();
    const place = await c.callTool({
      name: "kweli_get_place",
      arguments: { id: "musika-3" },
    });
    expect(place.structuredContent).toMatchObject({
      id: "place-03",
      verification: { tier: 3, label: "government" },
    });
    const org = await c.callTool({
      name: "kweli_get_organization",
      arguments: { id: "org-1" },
    });
    expect(org.structuredContent).toMatchObject({
      name: "Musika Traders",
      placeCount: 25,
      verification: { mineral: "Gold" },
    });
    const v = await c.callTool({
      name: "kweli_get_verification",
      arguments: { placeId: "place-01" },
    });
    expect(v.structuredContent).toMatchObject({
      kind: "place",
      tier: 1,
      label: "community",
      verified: true,
    });
  });

  it("returns not-found and bad arguments as actionable isError results", async () => {
    const c = await connect();
    const missing = await c.callTool({
      name: "kweli_get_place",
      arguments: { id: "nope" },
    });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("kweli_search_places");
    const both = await c.callTool({
      name: "kweli_get_verification",
      arguments: { placeId: "a", entityId: "b" },
    });
    expect(both.isError).toBe(true);
    expect(text(both)).toContain("exactly one");
    const outOfRange = await c.callTool({
      name: "kweli_compute_pluscode",
      arguments: { lat: 120, lng: 0 },
    });
    expect(outOfRange.isError).toBe(true);
  });

  it("computes a Plus Code", async () => {
    const r = await (
      await connect()
    ).callTool({
      name: "kweli_compute_pluscode",
      arguments: { lat: -17.8292, lng: 31.0522 },
    });
    expect((r.structuredContent as { plusCode: string }).plusCode).toMatch(
      /^[23456789CFGHJMPQRVWX]{8}\+[23456789CFGHJMPQRVWX]{2}$/,
    );
  });

  it("lists geo areas with a total, and counts per type without a geoType", async () => {
    const c = await connect();
    const page = await c.callTool({
      name: "kweli_list_geo_areas",
      arguments: { geoType: "country", limit: 2 },
    });
    expect(page.structuredContent).toMatchObject({
      total: 3,
      count: 2,
      has_more: true,
      next_offset: 2,
    });
    const summary = await c.callTool({
      name: "kweli_list_geo_areas",
      arguments: {},
    });
    expect(
      (summary.structuredContent as { summary: unknown[] }).summary.length,
    ).toBeGreaterThan(0);
  });

  it("reads a task and what it built from the ledger", async () => {
    const c = await connect();
    const status = await c.callTool({
      name: "kweli_get_task_status",
      arguments: { taskId: "task-1" },
    });
    expect(status.structuredContent).toMatchObject({
      task: { taskId: "task-1", status: "complete" },
    });
    const records = await c.callTool({
      name: "kweli_get_task_records",
      arguments: { taskId: "task-1" },
    });
    expect(records.structuredContent).toMatchObject({
      taskId: "task-1",
      total: 2,
      count: 2,
      has_more: false,
    });
    const missing = await c.callTool({
      name: "kweli_get_task_status",
      arguments: { taskId: "task-x" },
    });
    expect(missing.isError).toBe(true);
  });

  it("answers a legacy, unprefixed tool name", async () => {
    const r = await (
      await connect()
    ).callTool({ name: "get_place", arguments: { id: "place-02" } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ id: "place-02" });
  });

  it("explains a missing agent configuration instead of leaking internals", async () => {
    const r = await (
      await connect()
    ).callTool({
      name: "kweli_request_place",
      arguments: { name: "Office", lat: -17.8, lng: 31.0 },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("not configured");
  });

  it("keeps every result under CHARACTER_LIMIT", async () => {
    const r = await (
      await connect()
    ).callTool({ name: "kweli_search_places", arguments: { limit: 20 } });
    expect(text(r).length).toBeLessThanOrEqual(CHARACTER_LIMIT);
  });
});

describe("the MCP endpoint over HTTP", () => {
  it("refuses a foreign browser Origin with 403 and admits none / its own host", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    const req = (origin?: string) =>
      new Request("https://kweli.mukoko.com/mcp", {
        method: "POST",
        headers: origin ? { ...headers, origin } : headers,
        body,
      });
    expect(
      (await handler.fetch(req("https://evil.example"), ENV, CTX)).status,
    ).toBe(403);
    expect(
      (await handler.fetch(req("https://kweli.mukoko.com"), ENV, CTX)).status,
    ).toBe(200);
    expect((await handler.fetch(req(), ENV, CTX)).status).toBe(200);
  });

  it("answers GET with 405 (stateless: no standalone stream)", async () => {
    const res = await handler.fetch(
      new Request("https://kweli.mukoko.com/mcp", {
        headers: { accept: "text/event-stream" },
      }),
      ENV,
      CTX,
    );
    expect(res.status).toBe(405);
  });

  it("serves tools/list anonymously through the Worker, and 401s a gated tool with resource_metadata", async () => {
    const env = { ...ENV, OAUTH_KV: {} } as unknown as Env;
    const c = await connect((r) => worker.fetch(r, env, CTX));
    const { tools } = await c.listTools();
    expect(tools.length).toBe(15);
    const pc = await c.callTool({
      name: "kweli_compute_pluscode",
      arguments: { lat: 0, lng: 0 },
    });
    expect(pc.isError).toBeFalsy();

    const res = await worker.fetch(
      new Request("https://kweli.mukoko.com/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name: "kweli_seed_region", arguments: {} },
        }),
      }),
      env,
      CTX,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://kweli.mukoko.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("says plainly when the graph is not connected on a deployment", async () => {
    const env = { ...ENV, OAUTH_KV: {} } as unknown as Env;
    const c = await connect((r) => worker.fetch(r, env, CTX));
    const r = await c.callTool({ name: "kweli_get_open_stats", arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("not connected on this deployment");
    expect(text(r)).not.toContain("MONGODB_URI");
  });
});
