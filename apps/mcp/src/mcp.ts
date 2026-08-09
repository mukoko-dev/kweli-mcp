/**
 * KweliMcp — the Kweli MCP, built on the Agents SDK's McpAgent (a Durable
 * Object), behind WorkOS OAuth (Authorization Code + PKCE — see
 * authkit-handler.ts). It holds every Kweli function in one place: the
 * public graph reads (search_places, get_place, get_organization,
 * get_verification, get_open_stats), verification-tier inspection, and
 * place generation (seed_region, seed_admin_bulk, request_place).
 *
 * Generation tools do NOT touch the queue/ledger/Mongo directly — they mint
 * their own WorkOS M2M client_credentials token (this MCP's own dedicated
 * client_id/secret, distinct per target agent) and call
 * bulk-place-agent's / single-place-agent's public `POST /tasks` over a
 * service binding, exactly the way any other Nyuchi/Mukoko app would. The
 * agents are independent of this MCP; this MCP is just one more caller of
 * them, authenticating the same way everyone else does.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { EJSON } from "bson";
import type { MongoClient } from "mongodb";
import { z } from "zod";
import { fetchM2MToken } from "@kweli-mcp/workos-m2m";
import { buildSink, Tracer } from "@kweli-mcp/telemetry";
import { getTaskStatus } from "@kweli-mcp/shared";
import { BUNDU_COMMONS_ID, buildClient, COLLECTION, DB, tierSpec, verifyEntityUrl, verifyPlaceUrl } from "@kweli-mcp/mongo";
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

interface PlaceDoc {
  _id: string;
  name: string;
  slug?: string;
  placeType?: string[];
  description?: string;
  address?: { street?: string; city?: string; region?: string };
  geo?: { type: "Point"; coordinates: [number, number] };
  telephone?: string;
  url?: string;
  discovery?: { aggregateRating?: { value: number; count: number } };
  bundu?: { verificationTier?: number };
  ownerEntityId?: string;
}

interface EntityDoc {
  _id: string;
  name: string;
  legalName?: string;
  slug?: string;
  entityType?: string;
  schemaOrgType?: string;
  bundu?: { verificationTier?: number; trustSignals?: { ubuntuScore?: number } };
}

export class KweliMcp extends McpAgent<Env, unknown, Record<string, unknown>> {
  server = new McpServer({
    name: "kweli",
    title: "Mukoko Kweli — Africa Trust Platform",
    version: "1.0.0",
    description:
      "Places (every entity type), the organizations that operate them, the trust ladder that " +
      "travels with both, and place generation (bulk region seeding and single-named-place " +
      "requests). Read tools are safe to call freely; generation tools enqueue real work on " +
      "independent agents (bulk-place-agent, single-place-agent) that any Nyuchi/Mukoko app can " +
      "also call directly.",
    websiteUrl: "https://kweli.mukoko.com",
    icons: [
      {
        src: "https://kweli-mcp.nyuchi.dev/icon.svg",
        mimeType: "image/svg+xml",
        sizes: ["any"],
      },
    ],
  });

  // One tracer per Durable Object instance. `this.name` is the DO instance
  // name, so every event is already attributable to a specific MCP session
  // without threading an id through each tool.
  private _tracer?: Tracer;
  private get tracer(): Tracer {
    this._tracer ??= new Tracer({
      serviceName: "kweli-mcp",
      instanceId: this.name,
      sink: buildSink({ env: this.env }),
    });
    return this._tracer;
  }

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

  // Mints this MCP's own token for the target agent and calls its public
  // POST /tasks over the service binding — the same call any other
  // Nyuchi/Mukoko app would make, just routed through Cloudflare's network
  // instead of the public internet.
  private async callAgentTasks(
    agent: Fetcher,
    creds: { clientId: string; clientSecret: string; organizationId?: string },
    body: unknown,
  ): Promise<Response> {
    const token = await fetchM2MToken({
      authkitDomain: this.env.WORKOS_AUTHKIT_DOMAIN,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      organizationId: creds.organizationId,
    });
    // traceparent rides along so the agent's work joins this MCP call's
    // trace instead of starting an orphan. Without it the trace stops dead
    // at the service binding — exactly the boundary you most need to see
    // across when a seed silently produces nothing.
    return agent.fetch("https://internal/tasks", {
      method: "POST",
      headers: this.tracer.outboundHeaders({
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      }),
      body: JSON.stringify(body),
    });
  }

  async init() {
    // ---- generation (§5): forwarded to the independent agents ----

    this.server.tool(
      "seed_region",
      "Enqueue a bulk-place-agent seed task for a region. The main entry point — what a search-miss or app empty-state calls. Returns immediately with a task id; ingestion runs asynchronously on bulk-place-agent, which any Nyuchi/Mukoko app can also call directly at its own POST /tasks.",
      { region: regionSchema, categories: categoriesSchema.optional(), source: sourceSchema },
      { ...ENQUEUE, title: "Seed region" },
      async ({ region, categories, source }) => {
        try {
          const resp = await this.callAgentTasks(
            this.env.BULK_PLACE_AGENT,
            {
              clientId: this.env.BULK_M2M_CLIENT_ID,
              clientSecret: this.env.BULK_M2M_CLIENT_SECRET,
              organizationId: this.env.WORKOS_ORGANIZATION_ID,
            },
            { region, categories: categories ?? "all", source },
          );
          const body = await resp.json();
          if (!resp.ok) return fail(new Error(JSON.stringify(body)));
          return ok(body);
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.tool(
      "seed_admin_bulk",
      "Run a bulk generator (e.g. all African capitals, 20km radius) on bulk-place-agent. Fans one intent out into many atomic region tasks.",
      { intent: bulkIntentSchema },
      { ...ENQUEUE, title: "Bulk seed regions" },
      async ({ intent }) => {
        try {
          const resp = await this.callAgentTasks(
            this.env.BULK_PLACE_AGENT,
            {
              clientId: this.env.BULK_M2M_CLIENT_ID,
              clientSecret: this.env.BULK_M2M_CLIENT_SECRET,
              organizationId: this.env.WORKOS_ORGANIZATION_ID,
            },
            { intent },
          );
          const body = await resp.json();
          if (!resp.ok) return fail(new Error(JSON.stringify(body)));
          return ok(body);
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.tool(
      "request_place",
      "Ask single-place-agent to create exactly one named place on request (not an area sweep) — e.g. \"my company's office at this address\". Returns immediately with a task id; single-place-agent can also be called directly by any Nyuchi/Mukoko app at its own POST /tasks.",
      {
        name: z.string().min(1),
        lat: z.number().optional(),
        lng: z.number().optional(),
        address: z.string().optional(),
        requestedByPersonId: z.string().optional(),
      },
      { ...ENQUEUE, title: "Request a single named place" },
      async ({ name, lat, lng, address, requestedByPersonId }) => {
        try {
          const resp = await this.callAgentTasks(
            this.env.SINGLE_PLACE_AGENT,
            { clientId: this.env.SINGLE_M2M_CLIENT_ID, clientSecret: this.env.SINGLE_M2M_CLIENT_SECRET },
            { name, lat, lng, address, source: { kind: "ops_mcp", requestedByPersonId } },
          );
          const body = await resp.json();
          if (!resp.ok) return fail(new Error(JSON.stringify(body)));
          return ok(body);
        } catch (e) {
          return fail(e);
        }
      },
    );

    // ---- ingestion inspection (§5): local reads over the shared ledger/graph ----

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
      "Reverse-geocode a lat/lng via Nominatim and match against seeded placesGeo records to preview what hierarchy (countryId, provinceId, containedInPlaceId) a place at that location would be assigned.",
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

    // ---- public graph reads: places, organizations, verification ----

    this.server.tool(
      "search_places",
      "Search the Mukoko knowledge graph for places (businesses, parks, schools, NGOs, media, government offices, landmarks — every entity type) by name or city. Returns compact rows with id, name, type, city, rating, verification tier.",
      {
        query: z.string().optional(),
        city: z.string().optional(),
        limit: z.number().optional(),
      },
      { ...READ, title: "Search places" },
      async ({ query, city, limit }) => {
        try {
          const client = await this.getMongo();
          const filter: Record<string, unknown> = { isActive: { $ne: false } };
          if (query) filter.name = { $regex: escapeRegex(query), $options: "i" };
          if (city) filter["address.city"] = { $regex: `^${escapeRegex(city)}`, $options: "i" };

          const cap = Math.min(Math.max(Math.trunc(limit ?? 10), 1), 20);
          const docs = await client
            .db(DB.places)
            .collection<PlaceDoc>(COLLECTION.places)
            .find(filter, { limit: cap })
            .toArray();
          if (docs.length === 0) return ok("No places match that search.");
          return ok(docs.map(compactPlaceRow));
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.tool(
      "get_place",
      "Fetch a single place by its id or slug: name, type, address, coordinates, phone/website when present, rating, and verification tier.",
      { id: z.string().min(1) },
      { ...READ, title: "Get a place" },
      async ({ id }) => {
        try {
          const client = await this.getMongo();
          const col = client.db(DB.places).collection<PlaceDoc>(COLLECTION.places);
          const doc = (await col.findOne({ _id: id })) ?? (await col.findOne({ slug: id }));
          if (!doc) return fail(new Error(`get_place: no place found with id ${id}`));

          const tier = Number((doc.bundu as { verificationTier?: number } | undefined)?.verificationTier) || 0;
          return ok({
            id: doc._id,
            name: doc.name,
            type: doc.placeType,
            description: doc.description,
            address: doc.address,
            geo: doc.geo?.coordinates
              ? { lat: doc.geo.coordinates[1], lng: doc.geo.coordinates[0] }
              : null,
            ...(doc.telephone ? { phone: doc.telephone } : {}),
            ...(doc.url ? { website: doc.url } : {}),
            rating: doc.discovery?.aggregateRating ?? null,
            verification: { tier, label: tierSpec(tier).label },
            verifyUrl: verifyPlaceUrl(doc._id),
          });
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.tool(
      "get_organization",
      "Fetch the public trust profile of an organization (the entity node that operates places): name, legal name, entity type, verification tier, ubuntu trust score, and how many active places it operates.",
      { id: z.string().min(1) },
      { ...READ, title: "Get an organization" },
      async ({ id }) => {
        try {
          const client = await this.getMongo();
          const entities = client.db(DB.entity).collection<EntityDoc>(COLLECTION.entities);
          const doc = (await entities.findOne({ _id: id })) ?? (await entities.findOne({ slug: id }));
          if (!doc) return fail(new Error(`get_organization: no organization found with id ${id}`));

          const tier = Number((doc.bundu as { verificationTier?: number } | undefined)?.verificationTier) || 0;
          const spec = tierSpec(tier);
          const placeCount = await client
            .db(DB.places)
            .collection(COLLECTION.places)
            .countDocuments({ ownerEntityId: doc._id, isActive: { $ne: false } });

          return ok({
            id: doc._id,
            name: doc.name,
            legalName: doc.legalName,
            slug: doc.slug,
            entityType: doc.entityType,
            schemaOrgType: doc.schemaOrgType,
            placeCount,
            verification: { tier, label: spec.label, mineral: spec.mineral },
            ubuntuScore: (doc.bundu as { trustSignals?: { ubuntuScore?: number } } | undefined)?.trustSignals
              ?.ubuntuScore ?? null,
            verifyUrl: verifyEntityUrl(doc._id),
          });
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.tool(
      "get_verification",
      "Return the verification tier for a place OR an organization on the 4-tier Mukoko ladder (1 community/Terracotta, 2 otp/Cobalt, 3 government/Gold, 4 licensed/Tanzanite; 0 unverified), plus the Kweli verification gateway URL. Pass exactly one of placeId or entityId.",
      { placeId: z.string().optional(), entityId: z.string().optional() },
      { ...READ, title: "Get verification status" },
      async ({ placeId, entityId }) => {
        if (!placeId && !entityId) {
          return fail(new Error("get_verification: pass exactly one of placeId or entityId"));
        }
        if (placeId && entityId) {
          return fail(new Error("get_verification: pass exactly one of placeId or entityId, not both"));
        }
        try {
          const client = await this.getMongo();
          if (entityId) {
            const doc = await client.db(DB.entity).collection<EntityDoc>(COLLECTION.entities).findOne({ _id: entityId });
            if (!doc) return fail(new Error(`get_verification: no organization found with id ${entityId}`));
            const tier = Number((doc.bundu as { verificationTier?: number } | undefined)?.verificationTier) || 0;
            const spec = tierSpec(tier);
            return ok({
              entityId: doc._id,
              name: doc.name,
              tier,
              label: spec.label,
              mineral: spec.mineral,
              verified: tier > 0,
              verifyUrl: verifyEntityUrl(doc._id),
            });
          }
          const doc = await client.db(DB.places).collection<PlaceDoc>(COLLECTION.places).findOne({ _id: placeId });
          if (!doc) return fail(new Error(`get_verification: no place found with id ${placeId}`));
          const tier = Number((doc.bundu as { verificationTier?: number } | undefined)?.verificationTier) || 0;
          const spec = tierSpec(tier);
          return ok({
            placeId: doc._id,
            name: doc.name,
            tier,
            label: spec.label,
            mineral: spec.mineral,
            verified: tier > 0,
            verifyUrl: verifyPlaceUrl(doc._id),
          });
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.tool(
      "get_open_stats",
      "Open analytics over the graph: total places, counts by country, top cities, and verified counts by tier for both places and organizations.",
      {},
      { ...READ, title: "Get open analytics" },
      async () => {
        try {
          const client = await this.getMongo();
          const places = client.db(DB.places).collection(COLLECTION.places);
          const entities = client.db(DB.entity).collection(COLLECTION.entities);

          const [total, byCountry, topCities, byTier, orgsByTier] = await Promise.all([
            places.countDocuments({ isActive: { $ne: false } }),
            places
              .aggregate([
                { $match: { isActive: { $ne: false } } },
                { $group: { _id: "$hierarchy.countryId", count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: 20 },
              ])
              .toArray(),
            places
              .aggregate([
                { $match: { isActive: { $ne: false } } },
                { $group: { _id: "$address.city", count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: 10 },
              ])
              .toArray(),
            places
              .aggregate([{ $group: { _id: { $ifNull: ["$bundu.verificationTier", 0] }, count: { $sum: 1 } } }])
              .toArray(),
            entities
              .aggregate([{ $group: { _id: { $ifNull: ["$bundu.verificationTier", 0] }, count: { $sum: 1 } } }])
              .toArray(),
          ]);

          return ok({
            totalPlaces: total,
            byCountry,
            topCities,
            placesByTier: byTier,
            organizationsByTier: orgsByTier,
          });
        } catch (e) {
          return fail(e);
        }
      },
    );
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compactPlaceRow(doc: Record<string, unknown>) {
  const bundu = doc.bundu as { verificationTier?: number } | undefined;
  const address = doc.address as { city?: string } | undefined;
  const discovery = doc.discovery as { aggregateRating?: unknown } | undefined;
  return {
    id: doc._id,
    name: doc.name,
    type: Array.isArray(doc.placeType) ? doc.placeType[0] : null,
    city: address?.city ?? null,
    rating: discovery?.aggregateRating ?? null,
    tier: Number(bundu?.verificationTier) || 0,
  };
}
