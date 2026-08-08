// Fundi's MCP surface (§5), built on the Agents SDK's McpAgent (a Durable
// Object). Everything in the ecosystem is MCP: the search box, apps, and
// ops/you-via-an-MCP-client all invoke Fundi the same way. seed_region and the
// POST /tasks endpoint are two faces of the same enqueue path.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { EJSON } from "bson";
import type { MongoClient } from "mongodb";
import { z } from "zod";
import { submitBulkIntent, submitSeedTask } from "./enqueue";
import { getTaskStatus } from "@kweli-mcp/shared";
import { BUNDU_COMMONS_ID, buildClient, COLLECTION, DB } from "@kweli-mcp/mongo";
import { encodePlusCode } from "@kweli-mcp/shared";
import { overpassLookup } from "@kweli-mcp/skills";
import { resolveHierarchy } from "@kweli-mcp/skills";
import { bulkIntentSchema, categoriesSchema, regionSchema, sourceSchema } from "@kweli-mcp/shared";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

// Mongo documents carry BSON types (Date, Double); EJSON renders them cleanly.
function okEjson(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: EJSON.stringify(value, undefined, 2, { relaxed: true }) }],
  };
}

function fail(err: unknown): ToolResult {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

// MCP tool annotations: advisory hints clients use to render and guard tools.
// READ never mutates; ENQUEUE creates ingestion work (writes, but not
// destructive). `openWorldHint` is true only when a tool reaches an external
// service (e.g. Overpass / OSM).
const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const ENQUEUE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const PLACE_PROJECTION = {
  _id: 1,
  name: 1,
  slug: 1,
  placeType: 1,
  geo: 1,
  plusCode: 1,
  what3words: 1,
  "content.description": 1,
  ownerEntityId: 1,
  "sourceProvenance.legacyId": 1,
  "bundu.verificationTier": 1,
  createdAt: 1,
} as const;

const ENTITY_PROJECTION = {
  _id: 1,
  name: 1,
  slug: 1,
  schemaOrgType: 1,
  primaryPlaceId: 1,
  "bundu.verificationTier": 1,
  "sourceProvenance.legacyId": 1,
} as const;

export class FundiMcp extends McpAgent<Env, unknown, Record<string, unknown>> {
  server = new McpServer({
    name: "fundi",
    title: "Fundi — place ingestion",
    version: "0.1.0",
    description:
      "Agentic ingestion worker. Turns regions into clean, sovereign, tier-0 place and entity records.",
    websiteUrl: "https://fundi.nyuchi.dev",
    icons: [
      {
        src: "https://fundi-ingestion.nyuchi.dev/icon.svg",
        mimeType: "image/svg+xml",
        sizes: ["any"],
      },
    ],
  });

  // Cached read client for the inspection tools. Connect only inside a handler.
  private mongo?: MongoClient;
  private async getMongo(): Promise<MongoClient> {
    if (this.mongo) return this.mongo;
    const uri = this.env.MONGODB_URI;
    if (!uri) throw new Error("MONGODB_URI is not configured on the worker");
    const client = buildClient(uri);
    await client.connect();
    this.mongo = client;
    return client;
  }

  async init() {
    this.server.tool(
      "seed_region",
      "Enqueue a seed task for a region. The main entry point — what a search-miss or app empty-state calls. Returns immediately with a task id; ingestion runs asynchronously.",
      { region: regionSchema, categories: categoriesSchema.optional(), source: sourceSchema },
      { ...ENQUEUE, title: "Seed region" },
      async ({ region, categories, source }) => {
        try {
          const outcome = await submitSeedTask(this.env, {
            region,
            categories: categories ?? "all",
            source,
          });
          return ok({ ...outcome, message: "This region will exist going forward." });
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.tool(
      "seed_admin_bulk",
      "Run a bulk generator (e.g. all African capitals, 20km radius). Fans one intent out into many atomic region tasks.",
      { intent: bulkIntentSchema },
      { ...ENQUEUE, title: "Bulk seed regions" },
      async ({ intent }) => {
        try {
          const outcomes = await submitBulkIntent(this.env, intent);
          return ok({
            tasksCreated: outcomes.filter((o) => !o.deduped).length,
            deduped: outcomes.filter((o) => o.deduped).length,
            taskIds: outcomes.map((o) => o.taskId),
          });
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.tool(
      "task_status",
      "Look up a task in the ledger by id.",
      { taskId: z.string().min(1) },
      { ...READ, title: "Task status" },
      async ({ taskId }) => {
        try {
          const row = await getTaskStatus(this.env, taskId);
          return row ? ok(row) : fail(new Error(`task not found: ${taskId}`));
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.tool(
      "task_records",
      "Display exactly what a task built — the places (+ linked entities) it created, fetched by their logged ids. Deterministic per task, so concurrent tasks/users never interfere (unlike recency).",
      { taskId: z.string().min(1) },
      { ...READ, title: "Task records" },
      async ({ taskId }) => {
        try {
          const row = await getTaskStatus(this.env, taskId);
          if (!row) return fail(new Error(`task not found: ${taskId}`));
          const placeIds = row.records.map((r) => r.placeId);
          const entityIds = row.records
            .map((r) => r.entityId)
            .filter((id): id is string => Boolean(id));

          const client = await this.getMongo();
          const places = placeIds.length
            ? await client
                .db(DB.places)
                .collection(COLLECTION.places)
                .find({ _id: { $in: placeIds as never } }, { projection: PLACE_PROJECTION })
                .toArray()
            : [];
          const entities = entityIds.length
            ? await client
                .db(DB.entity)
                .collection(COLLECTION.entities)
                .find({ _id: { $in: entityIds as never } }, { projection: ENTITY_PROJECTION })
                .toArray()
            : [];

          return okEjson({
            taskId,
            status: row.status,
            summary: {
              placesCreated: row.placesCreated,
              entitiesCreated: row.entitiesCreated,
              skipped: row.skipped,
              logged: row.records.length,
            },
            places,
            entities,
          });
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.tool(
      "list_recent_places",
      "Show the tier-0 places Fundi has created (most recent first, or nearest to a point), each with its linked unverified entity. Reads places.places + entity.entities.",
      {
        limit: z.number().int().min(1).max(50).optional(),
        near: z.tuple([z.number(), z.number()]).optional().describe("[lng, lat] — return nearest"),
        radiusMeters: z.number().positive().max(50_000).optional(),
      },
      { ...READ, title: "List recent places" },
      async ({ limit, near, radiusMeters }) => {
        try {
          const client = await this.getMongo();
          const places = client.db(DB.places).collection(COLLECTION.places);
          const filter: Record<string, unknown> = { "sourceProvenance.dataOrigin": "osm" };

          let cursor;
          if (near) {
            filter.geo = {
              $near: {
                $geometry: { type: "Point", coordinates: near },
                $maxDistance: radiusMeters ?? 5000,
              },
            };
            cursor = places.find(filter, { projection: PLACE_PROJECTION, limit: limit ?? 10 });
          } else {
            cursor = places.find(filter, {
              projection: PLACE_PROJECTION,
              limit: limit ?? 10,
              sort: { createdAt: -1 },
            });
          }
          const placeDocs = await cursor.toArray();

          // Attach the linked entity for businesses (skip Bundu Commons custodian).
          const ownerIds = [
            ...new Set(
              placeDocs
                .map((p) => p.ownerEntityId as string)
                .filter((id) => id && id !== BUNDU_COMMONS_ID),
            ),
          ];
          const entityById = new Map<string, unknown>();
          if (ownerIds.length) {
            const entities = await client
              .db(DB.entity)
              .collection(COLLECTION.entities)
              .find({ _id: { $in: ownerIds as never } }, { projection: ENTITY_PROJECTION })
              .toArray();
            for (const e of entities) entityById.set(String(e._id), e);
          }

          const results = placeDocs.map((p) => ({
            ...p,
            entity: entityById.get(p.ownerEntityId as string) ?? null,
          }));
          return okEjson({ count: results.length, places: results });
        } catch (e) {
          return fail(e);
        }
      },
    );

    // ---- skills exposed for direct invocation / testing (§5) ----

    this.server.tool(
      "compute_pluscode",
      "Compute an Open Location Code (Plus Code) from lat/lng, locally — no API, no key.",
      { lat: z.number(), lng: z.number(), codeLength: z.number().int().min(2).max(15).optional() },
      { ...READ, title: "Compute Plus Code" },
      async ({ lat, lng, codeLength }) => {
        try {
          return ok({ plusCode: encodePlusCode(lat, lng, codeLength ?? 10) });
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.tool(
      "overpass_lookup",
      "Query OSM/Overpass for features in a bbox by category (read-only; does not write records).",
      {
        bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).describe("[s, w, n, e]"),
        categories: categoriesSchema.optional(),
        endpoint: z.string().url().optional(),
      },
      { ...READ, openWorldHint: true, title: "Overpass lookup" },
      async ({ bbox, categories, endpoint }) => {
        try {
          const [s, w, n, e] = bbox;
          const features = await overpassLookup(
            { endpoint: endpoint ?? "https://overpass-api.de/api/interpreter" },
            { s, w, n, e },
            categories ?? "all",
          );
          return ok({ count: features.length, features: features.slice(0, 50) });
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.tool(
      "resolve_hierarchy",
      "Reverse-geocode a lat/lng via Nominatim and match against seeded placesGeo records to preview what hierarchy (countryId, provinceId, containedInPlaceId) Fundi would assign to a place at that location.",
      {
        lat: z.number(),
        lng: z.number(),
        endpoint: z.string().url().optional().describe("Nominatim base URL override."),
      },
      { ...READ, openWorldHint: true, title: "Resolve hierarchy" },
      async ({ lat, lng, endpoint }) => {
        try {
          const client = await this.getMongo();
          const placesDb = client.db(DB.places);
          const result = await resolveHierarchy(
            { endpoint: endpoint ?? "https://nominatim.openstreetmap.org" },
            placesDb,
            lat,
            lng,
          );
          return ok(result);
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.tool(
      "list_geo_areas",
      "List seeded administrative areas in placesGeo by type (continent, country, province, city, town, village, district, region). Shows what geographic hierarchy data is available for containment resolution.",
      {
        geoType: z
          .enum(["continent", "country", "province", "city", "town", "village", "district", "region"])
          .optional()
          .describe("Filter by admin level. Omit to see counts across all types."),
        parentPlaceId: z.string().optional().describe("Filter to children of a specific parent."),
        limit: z.number().int().min(1).max(100).default(20),
      },
      { ...READ, title: "List geo areas" },
      async ({ geoType, parentPlaceId, limit }) => {
        try {
          const client = await this.getMongo();
          const col = client.db(DB.places).collection(COLLECTION.placesGeo);

          if (!geoType) {
            const counts = await col
              .aggregate([{ $group: { _id: "$geoType", count: { $sum: 1 } } }, { $sort: { count: -1 } }])
              .toArray();
            return ok({ summary: counts });
          }

          const filter: Record<string, unknown> = { geoType };
          if (parentPlaceId) filter.parentPlaceId = parentPlaceId;

          const docs = await col
            .find(filter, {
              projection: { _id: 1, name: 1, geoType: 1, isoCode: 1, parentPlaceId: 1, population: 1 },
              limit,
              sort: { name: 1 },
            })
            .toArray();
          return okEjson({ count: docs.length, areas: docs });
        } catch (e) {
          return fail(e);
        }
      },
    );
  }
}
