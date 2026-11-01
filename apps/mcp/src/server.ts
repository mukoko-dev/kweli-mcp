/**
 * The Kweli MCP server, built on the official MCP TypeScript SDK v2
 * (`@modelcontextprotocol/server`). `createKweliServer` returns a fresh
 * `McpServer` with every tool and resource registered; `mcp-handler.ts`
 * calls it once per HTTP request (stateless Streamable HTTP), so nothing is
 * shared between requests.
 *
 * It holds every Kweli function in one place: the public graph reads
 * (kweli_search_places, kweli_get_place, kweli_get_organization,
 * kweli_get_verification, kweli_get_open_stats, kweli_compute_pluscode),
 * ingestion inspection, and place generation (kweli_seed_region,
 * kweli_seed_admin_bulk, kweli_request_place).
 *
 * Generation tools do NOT touch the queue/ledger/Mongo directly. They mint
 * this MCP's own WorkOS M2M client_credentials token (a dedicated client per
 * target agent) and call bulk-place-agent's / single-place-agent's public
 * `POST /tasks` over a service binding, exactly as any other Nyuchi/Mukoko app
 * would.
 *
 * Tool names carry the `kweli_` prefix so they cannot collide with another
 * server's `search_places` in a multi-server client. The unprefixed names the
 * Next.js MCP and earlier builds used stay callable through
 * `LEGACY_TOOL_ALIASES` (public-gate.ts); they are not listed.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { EJSON } from "bson";
import type { MongoClient } from "mongodb";
import * as z from "zod/v4";
import {
  BUNDU_COMMONS_ID,
  COLLECTION,
  DB,
  tierSpec,
  verifyEntityUrl,
  verifyPlaceUrl,
} from "@kweli-mcp/mongo";
import {
  bulkIntentSchema,
  categoriesSchema,
  encodePlusCode,
  getTaskStatus,
  regionSchema,
  sourceSchema,
} from "@kweli-mcp/shared";
import { overpassLookup, resolveHierarchy } from "@kweli-mcp/skills";
import { fetchM2MToken } from "@kweli-mcp/workos-m2m";
import type { Tracer } from "@kweli-mcp/telemetry";
import { requireAuthkitDomain } from "./authkit-handler";
import {
  PLACES_APP_CSP,
  PLACES_APP_HTML,
  PLACES_APP_MIME,
  PLACES_APP_URI,
} from "./places-app";

export const SERVER_NAME = "kweli";
export const SERVER_VERSION = "1.1.0";

/** Responses stay under this many characters by returning fewer items. */
export const CHARACTER_LIMIT = 25_000;
/** Upper bound on every Mongo operation (a slow read fails, it never hangs). */
export const MONGO_MAX_TIME_MS = 10_000;
/** Upper bound on each outbound HTTP call (Overpass, Nominatim, agents, WorkOS). */
export const UPSTREAM_TIMEOUT_MS = 25_000;

const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";
const NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org";

/** What the server needs from its host; injected so tests can stub it. */
export interface KweliDeps {
  env: Env;
  /** A Mongo client for this request; throws a ConfigError when unconfigured. */
  mongo(): Promise<MongoClient>;
  tracer: Tracer;
}

/** A failure whose message is already safe and actionable for the model. */
export class ToolError extends Error {
  override name = "ToolError";
}

/** The deployment is missing configuration a tool needs. */
export class ConfigError extends ToolError {}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

type TextBlock = { type: "text"; text: string };

/** BSON (Date, Double, ObjectId) → plain JSON, so it fits structuredContent. */
function toPlainJson<T>(value: T): T {
  return JSON.parse(
    EJSON.stringify(value, undefined, undefined, { relaxed: true }),
  ) as T;
}

/** A successful JSON result: the text block is exactly the structured content. */
function jsonResult<T extends Record<string, unknown>>(value: T) {
  const structuredContent = toPlainJson(value);
  return {
    content: [
      { type: "text", text: JSON.stringify(structuredContent) } as TextBlock,
    ],
    structuredContent,
  };
}

/** A tool error the model can act on. Never carries an internal message. */
function toolError(message: string) {
  return {
    content: [{ type: "text", text: message } as TextBlock],
    isError: true,
  };
}

/**
 * Turn any thrown value into an actionable tool error. A ToolError's message
 * is passed through; anything else is logged (with the tool name) and
 * replaced with generic, safe text.
 */
function failure(tool: string, error: unknown) {
  if (error instanceof ToolError) return toolError(error.message);
  if (error instanceof Error && error.name === "TimeoutError") {
    return toolError(
      `${tool}: an upstream service did not answer within ${UPSTREAM_TIMEOUT_MS / 1000}s. Try again shortly, or narrow the request.`,
    );
  }
  if (
    error instanceof Error &&
    /MaxTimeMSExpired|operation exceeded time limit/i.test(error.message)
  ) {
    return toolError(
      `${tool}: the query took longer than ${MONGO_MAX_TIME_MS / 1000}s and was stopped. Narrow it (a more specific query or a city) and try again.`,
    );
  }
  console.error(`[kweli-mcp] ${tool} failed:`, error);
  return toolError(
    `${tool}: an internal error occurred and was logged. Try again shortly.`,
  );
}

/** Wrap a handler so every throw becomes an isError result. */
function guarded<A, R>(tool: string, fn: (args: A) => Promise<R>) {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (error) {
      return failure(tool, error);
    }
  };
}

/**
 * Page `items` and shrink the page until its JSON fits CHARACTER_LIMIT.
 * `next_offset` always points at the first item left out.
 */
function page<T>(
  items: T[],
  offset: number,
  total: number | null,
  hasMoreBeyond: boolean,
  extra: Record<string, unknown> = {},
) {
  let shown = items;
  const build = (rows: T[]) => {
    const nextOffset = offset + rows.length;
    const hasMore = rows.length < items.length || hasMoreBeyond;
    return {
      ...extra,
      total,
      count: rows.length,
      offset,
      items: rows,
      has_more: hasMore,
      ...(hasMore ? { next_offset: nextOffset } : {}),
      ...(rows.length < items.length ? { truncated: true } : {}),
    };
  };
  let body = build(shown);
  while (
    shown.length > 1 &&
    JSON.stringify(toPlainJson(body)).length > CHARACTER_LIMIT
  ) {
    shown = shown.slice(0, Math.ceil(shown.length / 2));
    body = build(shown);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const READ_EXTERNAL = { ...READ, openWorldHint: true } as const;
// Enqueue real ingestion work on the agents, which query OSM/Overpass,
// Nominatim and AI services: writes (not destructive), external, and a repeat
// enqueues a second task (not idempotent).
const ENQUEUE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const idSchema = (what: string) => z.string().min(1).max(200).describe(what);
const latSchema = z
  .number()
  .min(-90)
  .max(90)
  .describe("Latitude in decimal degrees (WGS 84), e.g. -17.8292.");
const lngSchema = z
  .number()
  .min(-180)
  .max(180)
  .describe("Longitude in decimal degrees (WGS 84), e.g. 31.0522.");
const limitSchema = (max: number, dflt: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .default(dflt)
    .describe(`Maximum items to return (1-${max}, default ${dflt}).`);
const offsetSchema = z
  .number()
  .int()
  .min(0)
  .max(10_000)
  .default(0)
  .describe(
    "Items to skip, for pagination: pass the previous page's next_offset.",
  );

const pageOutput = (item: z.ZodType) => ({
  total: z
    .number()
    .int()
    .nullable()
    .describe(
      "Total matches, or null when it is not counted (geo and text searches).",
    ),
  count: z.number().int(),
  offset: z.number().int(),
  items: z.array(item),
  has_more: z.boolean(),
  next_offset: z.number().int().optional(),
  truncated: z.boolean().optional(),
});

const verificationSchema = z.object({
  tier: z.number().int().describe("0 unverified … 4 licensed."),
  label: z.string(),
  mineral: z.string().nullable(),
});

const placeRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string().nullable(),
  city: z.string().nullable(),
  rating: z.unknown().nullable(),
  tier: z.number().int(),
  tierLabel: z.string(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  image: z.string().nullable(),
  url: z.string(),
});

const looseDoc = z.record(z.string(), z.unknown());

const taskOutput = z.object({
  agent: z.string(),
  status: z.number().int().describe("HTTP status the agent answered with."),
  result: z
    .unknown()
    .describe("The agent's response body (task id and state)."),
});

// ---------------------------------------------------------------------------
// Mongo shapes and helpers
// ---------------------------------------------------------------------------

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
  bundu?: {
    verificationTier?: number;
    trustSignals?: { ubuntuScore?: number };
  };
  media?: { coverImage?: string; image?: string[] };
  ownerEntityId?: string;
}

interface EntityDoc {
  _id: string;
  name: string;
  legalName?: string;
  slug?: string;
  entityType?: string;
  schemaOrgType?: string;
  bundu?: {
    verificationTier?: number;
    trustSignals?: { ubuntuScore?: number };
  };
}

function tierOf(doc: { bundu?: { verificationTier?: number } }): number {
  return Number(doc.bundu?.verificationTier) || 0;
}

function verificationOf(doc: { bundu?: { verificationTier?: number } }) {
  const tier = tierOf(doc);
  const spec = tierSpec(tier);
  return { tier, label: spec.label, mineral: spec.mineral };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The Kweli web app resolves `/bars/<id>` to a place's canonical URL (a 301). */
function placeUrl(id: unknown): string {
  return `https://kweli.mukoko.com/bars/${encodeURIComponent(String(id))}`;
}

function placeRow(doc: PlaceDoc) {
  const tier = tierOf(doc);
  return {
    id: String(doc._id),
    name: doc.name,
    type: Array.isArray(doc.placeType) ? (doc.placeType[0] ?? null) : null,
    city: doc.address?.city ?? null,
    rating: doc.discovery?.aggregateRating ?? null,
    tier,
    tierLabel: tierSpec(tier).label,
    lat: doc.geo?.coordinates?.[1] ?? null,
    lng: doc.geo?.coordinates?.[0] ?? null,
    image: doc.media?.coverImage ?? doc.media?.image?.[0] ?? null,
    url: placeUrl(doc._id),
  };
}

/** fetch with this server's timeout, for the skills' injectable fetchImpl. */
const timedFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

export function createKweliServer(deps: KweliDeps): McpServer {
  const { env, tracer } = deps;
  const maxTimeMS = MONGO_MAX_TIME_MS;

  const server = new McpServer(
    {
      name: SERVER_NAME,
      title: "Mukoko Kweli — Trust Platform for Africa and Emerging Markets",
      version: SERVER_VERSION,
      description:
        "Places (every entity type), the organizations that operate them, the trust ladder that " +
        "travels with both, and place generation (bulk region seeding and single-named-place " +
        "requests).",
      websiteUrl: "https://kweli.mukoko.com",
      icons: [
        {
          src: "https://kweli.mukoko.com/mcp/icon.svg",
          mimeType: "image/svg+xml",
          sizes: ["any"],
        },
      ],
    },
    {
      instructions:
        "Kweli is Mukoko's trust graph for Africa: places, the organizations that operate them, and " +
        "their verification tier (0 unverified … 4 licensed). Start with kweli_search_places, then " +
        "kweli_get_place / kweli_get_organization / kweli_get_verification for one record. The graph " +
        "reads and kweli_compute_pluscode are open; every other tool needs sign-in. Generation tools " +
        "(kweli_seed_region, kweli_seed_admin_bulk, kweli_request_place) enqueue real ingestion work: " +
        "use them only when a place is genuinely missing, then follow the returned task id with " +
        "kweli_get_task_status and kweli_get_task_records.",
    },
  );

  async function mongo(): Promise<MongoClient> {
    return deps.mongo();
  }

  /** Mint this MCP's own M2M token and POST to an agent's public /tasks. */
  async function callAgentTasks(
    agentName: string,
    agent: Fetcher,
    creds: { clientId: string; clientSecret: string; organizationId?: string },
    body: unknown,
  ) {
    if (!creds.clientId || !creds.clientSecret) {
      throw new ConfigError(
        `${agentName} is not configured on this deployment (no M2M credentials), so generation is unavailable. Ask an operator.`,
      );
    }
    const token = await fetchM2MToken({
      authkitDomain: requireAuthkitDomain(env),
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      organizationId: creds.organizationId,
    });
    const resp = await agent.fetch("https://internal/tasks", {
      method: "POST",
      headers: tracer.outboundHeaders({
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    let result: unknown = null;
    try {
      result = await resp.json();
    } catch {
      result = null;
    }
    if (!resp.ok) {
      // A 4xx is the agent rejecting the request: its own error text is about
      // the arguments, so the model can fix them. Anything else is ours.
      const reason =
        resp.status >= 400 &&
        resp.status < 500 &&
        result &&
        typeof result === "object"
          ? String(
              (result as { error?: unknown; message?: unknown }).error ??
                (result as { message?: unknown }).message ??
                "",
            )
          : "";
      throw new ToolError(
        resp.status >= 400 && resp.status < 500
          ? `${agentName} rejected the task (HTTP ${resp.status})${reason ? `: ${reason.slice(0, 300)}` : ""}. Check the arguments and try again.`
          : `${agentName} failed to accept the task (HTTP ${resp.status}). Try again shortly.`,
      );
    }
    return { agent: agentName, status: resp.status, result };
  }

  // ---- generation: forwarded to the independent agents ----

  server.registerTool(
    "kweli_seed_region",
    {
      title: "Seed a region with places",
      description:
        "Enqueue a bulk seed of OSM places for one region on bulk-place-agent. Use when a search for an " +
        "area comes back empty and the area should exist in the graph (a search-miss or an app " +
        "empty-state). Returns at once with the agent's task id; ingestion runs asynchronously, so " +
        "follow it with kweli_get_task_status and kweli_get_task_records. Not for one named place: " +
        "use kweli_request_place.",
      inputSchema: z.object({
        region: regionSchema.describe(
          "The area: {kind:'point_radius', center:[lng,lat], radiusMeters}, {kind:'bbox', bbox:[s,w,n,e]}, or {kind:'admin', adminPlaceId}.",
        ),
        categories: categoriesSchema.optional(),
        source: sourceSchema.describe(
          "Why this seed was asked for, e.g. {kind:'ops_mcp'}.",
        ),
      }),
      outputSchema: taskOutput,
      annotations: ENQUEUE,
    },
    guarded("kweli_seed_region", async ({ region, categories, source }) =>
      jsonResult(
        await callAgentTasks(
          "bulk-place-agent",
          env.BULK_PLACE_AGENT,
          {
            clientId: env.BULK_M2M_CLIENT_ID,
            clientSecret: env.BULK_M2M_CLIENT_SECRET,
            organizationId: env.WORKOS_ORGANIZATION_ID,
          },
          { region, categories: categories ?? "all", source },
        ),
      ),
    ),
  );

  server.registerTool(
    "kweli_seed_admin_bulk",
    {
      title: "Bulk seed many regions",
      description:
        "Fan one bulk intent (e.g. every African capital at a 20 km radius, or every settlement in a " +
        "country) out into many atomic region seeds on bulk-place-agent. Heavy: use only for planned " +
        "coverage work, not to fill a single gap (use kweli_seed_region for that). Returns the agent's " +
        "response with the task ids.",
      inputSchema: z.object({ intent: bulkIntentSchema }),
      outputSchema: taskOutput,
      annotations: ENQUEUE,
    },
    guarded("kweli_seed_admin_bulk", async ({ intent }) =>
      jsonResult(
        await callAgentTasks(
          "bulk-place-agent",
          env.BULK_PLACE_AGENT,
          {
            clientId: env.BULK_M2M_CLIENT_ID,
            clientSecret: env.BULK_M2M_CLIENT_SECRET,
            organizationId: env.WORKOS_ORGANIZATION_ID,
          },
          { intent },
        ),
      ),
    ),
  );

  server.registerTool(
    "kweli_request_place",
    {
      title: "Request one named place",
      description:
        "Ask single-place-agent to create exactly one named place, e.g. \"my company's office at this " +
        'address". Search first (kweli_search_places): a repeat request creates a duplicate task. ' +
        "Give coordinates when you have them; otherwise an address. Returns at once with a task id.",
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .max(200)
          .describe("The place's name, e.g. 'Mbare Musika'."),
        lat: latSchema.optional(),
        lng: lngSchema.optional(),
        address: z
          .string()
          .max(500)
          .optional()
          .describe("Street address, used when lat/lng are unknown."),
        requestedByPersonId: z
          .string()
          .max(200)
          .optional()
          .describe("The requesting person's id, if known."),
      }),
      outputSchema: taskOutput,
      annotations: ENQUEUE,
    },
    guarded(
      "kweli_request_place",
      async ({ name, lat, lng, address, requestedByPersonId }) =>
        jsonResult(
          await callAgentTasks(
            "single-place-agent",
            env.SINGLE_PLACE_AGENT,
            {
              clientId: env.SINGLE_M2M_CLIENT_ID,
              clientSecret: env.SINGLE_M2M_CLIENT_SECRET,
            },
            {
              name,
              lat,
              lng,
              address,
              source: { kind: "ops_mcp", requestedByPersonId },
            },
          ),
        ),
    ),
  );

  // ---- ingestion inspection ----

  server.registerTool(
    "kweli_get_task_status",
    {
      title: "Get an ingestion task's status",
      description:
        "Look up one ingestion task in the ledger by the task id a generation tool returned: its status, " +
        "counts (places and entities created, skipped) and timing. Use kweli_get_task_records for the " +
        "places it actually built.",
      inputSchema: z.object({
        taskId: idSchema("Task id returned by a generation tool."),
      }),
      outputSchema: z.object({ task: looseDoc }),
      annotations: READ,
    },
    guarded("kweli_get_task_status", async ({ taskId }) => {
      const row = await getTaskStatus(env, taskId);
      if (!row) {
        throw new ToolError(
          `kweli_get_task_status: no task with id '${taskId}'. Check the id a generation tool returned.`,
        );
      }
      return jsonResult({ task: row as unknown as Record<string, unknown> });
    }),
  );

  server.registerTool(
    "kweli_get_task_records",
    {
      title: "List what an ingestion task built",
      description:
        "List exactly the places (and their linked unverified organizations) one task created, by the " +
        "ids the task logged. Deterministic per task, unlike recency, so concurrent tasks never " +
        "interfere. Paginated over the task's places.",
      inputSchema: z.object({
        taskId: idSchema("Task id returned by a generation tool."),
        limit: limitSchema(50, 20),
        offset: offsetSchema,
      }),
      outputSchema: z.object({
        taskId: z.string(),
        status: z.string(),
        summary: looseDoc,
        ...pageOutput(looseDoc),
        entities: z.array(looseDoc),
      }),
      annotations: READ,
    },
    guarded("kweli_get_task_records", async ({ taskId, limit, offset }) => {
      const row = await getTaskStatus(env, taskId);
      if (!row) {
        throw new ToolError(
          `kweli_get_task_records: no task with id '${taskId}'. Check the id a generation tool returned.`,
        );
      }
      const records = row.records.slice(offset, offset + limit);
      const placeIds = records.map((r) => r.placeId);
      const entityIds = records
        .map((r) => r.entityId)
        .filter((id): id is string => Boolean(id));
      const client = await mongo();
      const places = placeIds.length
        ? await client
            .db(DB.places)
            .collection(COLLECTION.places)
            .find(
              { _id: { $in: placeIds as never } },
              { projection: PLACE_PROJECTION, maxTimeMS },
            )
            .toArray()
        : [];
      const entities = entityIds.length
        ? await client
            .db(DB.entity)
            .collection(COLLECTION.entities)
            .find(
              { _id: { $in: entityIds as never } },
              { projection: ENTITY_PROJECTION, maxTimeMS },
            )
            .toArray()
        : [];
      return jsonResult({
        taskId,
        status: String(row.status),
        summary: {
          placesCreated: row.placesCreated,
          entitiesCreated: row.entitiesCreated,
          skipped: row.skipped,
          logged: row.records.length,
        },
        ...page(
          places as Record<string, unknown>[],
          offset,
          row.records.length,
          offset + limit < row.records.length,
        ),
        entities: entities as Record<string, unknown>[],
      });
    }),
  );

  server.registerTool(
    "kweli_list_recent_places",
    {
      title: "List places Fundi created",
      description:
        "List the tier-0 places the Fundi ingestion created from OSM, newest first, or nearest first " +
        "when `near` is given, each with its linked unverified organization. Use to review fresh " +
        "ingestion; use kweli_search_places to find a place by name.",
      inputSchema: z.object({
        limit: limitSchema(50, 10),
        offset: offsetSchema,
        near: z
          .tuple([lngSchema, latSchema])
          .optional()
          .describe("[lng, lat]: return the places nearest this point."),
        radiusMeters: z
          .number()
          .positive()
          .max(50_000)
          .optional()
          .describe("With `near`: search radius in metres (default 5000)."),
      }),
      outputSchema: z.object(pageOutput(looseDoc)),
      annotations: READ,
    },
    guarded(
      "kweli_list_recent_places",
      async ({ limit, offset, near, radiusMeters }) => {
        const client = await mongo();
        const places = client.db(DB.places).collection(COLLECTION.places);
        const filter: Record<string, unknown> = {
          "sourceProvenance.dataOrigin": "osm",
        };
        if (near) {
          filter.geo = {
            $near: {
              $geometry: { type: "Point", coordinates: near },
              $maxDistance: radiusMeters ?? 5000,
            },
          };
        }
        const docs = await places
          .find(filter, {
            projection: PLACE_PROJECTION,
            skip: offset,
            limit: limit + 1,
            maxTimeMS,
            ...(near ? {} : { sort: { createdAt: -1 } }),
          })
          .toArray();
        const hasMore = docs.length > limit;
        const placeDocs = docs.slice(0, limit);
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
            .find(
              { _id: { $in: ownerIds as never } },
              { projection: ENTITY_PROJECTION, maxTimeMS },
            )
            .toArray();
          for (const e of entities) entityById.set(String(e._id), e);
        }
        const rows = placeDocs.map((p) => ({
          ...p,
          entity: entityById.get(p.ownerEntityId as string) ?? null,
        }));
        return jsonResult(
          page(rows as Record<string, unknown>[], offset, null, hasMore),
        );
      },
    ),
  );

  server.registerTool(
    "kweli_compute_pluscode",
    {
      title: "Compute a Plus Code",
      description:
        "Compute the Open Location Code (Plus Code) for a latitude/longitude, locally, with no API call. " +
        "Use when you need a shareable address for a point, e.g. a place without a street address.",
      inputSchema: z.object({
        lat: latSchema,
        lng: lngSchema,
        codeLength: z
          .number()
          .int()
          .min(2)
          .max(15)
          .default(10)
          .describe(
            "Code length: 10 (default) is about a 14 m square; 11 is about 3 m.",
          ),
      }),
      outputSchema: z.object({
        plusCode: z.string(),
        lat: z.number(),
        lng: z.number(),
        codeLength: z.number().int(),
      }),
      annotations: READ,
    },
    guarded("kweli_compute_pluscode", async ({ lat, lng, codeLength }) =>
      jsonResult({
        plusCode: encodePlusCode(lat, lng, codeLength),
        lat,
        lng,
        codeLength,
      }),
    ),
  );

  server.registerTool(
    "kweli_overpass_lookup",
    {
      title: "Look up OSM features in a box",
      description:
        "Query OpenStreetMap (Overpass) for features in a bounding box, by category. Read-only: it " +
        "writes nothing to the graph. Use to preview what a kweli_seed_region would find. Keep boxes " +
        "small (a neighbourhood): large boxes time out. Paginated.",
      inputSchema: z.object({
        bbox: z
          .tuple([latSchema, lngSchema, latSchema, lngSchema])
          .describe("[south, west, north, east] in decimal degrees."),
        categories: categoriesSchema.optional(),
        limit: limitSchema(100, 50),
        offset: offsetSchema,
      }),
      outputSchema: z.object(pageOutput(looseDoc)),
      annotations: READ_EXTERNAL,
    },
    guarded(
      "kweli_overpass_lookup",
      async ({ bbox, categories, limit, offset }) => {
        const [s, w, n, e] = bbox;
        if (s >= n || w >= e) {
          throw new ToolError(
            "kweli_overpass_lookup: bbox must be [south, west, north, east] with south < north and west < east.",
          );
        }
        let features;
        try {
          features = await overpassLookup(
            { endpoint: OVERPASS_ENDPOINT, fetchImpl: timedFetch },
            { s, w, n, e },
            categories ?? "all",
          );
        } catch (error) {
          if (error instanceof Error && error.name === "TimeoutError")
            throw error;
          throw new ToolError(
            "kweli_overpass_lookup: Overpass could not answer this query (it may be busy or the box too large). Try a smaller box or try again shortly.",
          );
        }
        const rows = features.slice(offset, offset + limit);
        return jsonResult(
          page(
            rows as unknown as Record<string, unknown>[],
            offset,
            features.length,
            offset + limit < features.length,
          ),
        );
      },
    ),
  );

  server.registerTool(
    "kweli_resolve_hierarchy",
    {
      title: "Preview a point's place hierarchy",
      description:
        "Reverse-geocode a point with Nominatim and match it against the seeded administrative areas " +
        "(placesGeo), to preview which country, province and containing place a place there would be " +
        "assigned. Read-only.",
      inputSchema: z.object({ lat: latSchema, lng: lngSchema }),
      outputSchema: z.object({
        countryId: z.string().nullable(),
        countryCode: z.string().nullable(),
        provinceId: z.string().nullable(),
        containedInPlaceId: z.string().nullable(),
        countryName: z.string().nullable(),
        provinceName: z.string().nullable(),
        cityName: z.string().nullable(),
      }),
      annotations: READ_EXTERNAL,
    },
    guarded("kweli_resolve_hierarchy", async ({ lat, lng }) => {
      const client = await mongo();
      const result = await resolveHierarchy(
        { endpoint: NOMINATIM_ENDPOINT, fetchImpl: timedFetch },
        client.db(DB.places),
        lat,
        lng,
      );
      return jsonResult({ ...result });
    }),
  );

  const GEO_TYPES = [
    "continent",
    "country",
    "province",
    "city",
    "town",
    "village",
    "district",
    "region",
  ] as const;

  server.registerTool(
    "kweli_list_geo_areas",
    {
      title: "List seeded administrative areas",
      description:
        "List the administrative areas seeded in placesGeo, by type (continent, country, province, city, " +
        "town, village, district, region), optionally under one parent. Omit geoType for a count per type. " +
        "Use to find an adminPlaceId for kweli_seed_region, or a country id for a bulk seed. Sorted by name; paginated.",
      inputSchema: z.object({
        geoType: z
          .enum(GEO_TYPES)
          .optional()
          .describe(
            "Admin level to list. Omit to get counts across all types.",
          ),
        parentPlaceId: idSchema(
          "Only the children of this placesGeo id.",
        ).optional(),
        limit: limitSchema(100, 20),
        offset: offsetSchema,
      }),
      outputSchema: z.object({
        summary: z
          .array(
            z.object({
              geoType: z.string().nullable(),
              count: z.number().int(),
            }),
          )
          .optional(),
        total: z.number().int().nullable().optional(),
        count: z.number().int().optional(),
        offset: z.number().int().optional(),
        items: z.array(looseDoc).optional(),
        has_more: z.boolean().optional(),
        next_offset: z.number().int().optional(),
        truncated: z.boolean().optional(),
      }),
      annotations: READ,
    },
    guarded(
      "kweli_list_geo_areas",
      async ({ geoType, parentPlaceId, limit, offset }) => {
        const client = await mongo();
        const col = client.db(DB.places).collection(COLLECTION.placesGeo);
        if (!geoType) {
          const counts = await col
            .aggregate(
              [
                { $group: { _id: "$geoType", count: { $sum: 1 } } },
                { $sort: { count: -1 } },
              ],
              { maxTimeMS },
            )
            .toArray();
          return jsonResult({
            summary: counts.map((c) => ({
              geoType: (c._id as string | null) ?? null,
              count: Number(c.count),
            })),
          });
        }
        const filter: Record<string, unknown> = { geoType };
        if (parentPlaceId) filter.parentPlaceId = parentPlaceId;
        const [total, docs] = await Promise.all([
          col.countDocuments(filter, { maxTimeMS }),
          col
            .find(filter, {
              projection: {
                _id: 1,
                name: 1,
                geoType: 1,
                isoCode: 1,
                parentPlaceId: 1,
                population: 1,
              },
              sort: { name: 1 },
              skip: offset,
              limit,
              maxTimeMS,
            })
            .toArray(),
        ]);
        return jsonResult(
          page(
            docs as Record<string, unknown>[],
            offset,
            total,
            offset + docs.length < total,
          ),
        );
      },
    ),
  );

  // ---- public graph reads ----

  // The places map MCP App view: hosts that support MCP Apps render
  // kweli_search_places results with it (see ./places-app.ts).
  const uiMeta = { ui: { csp: PLACES_APP_CSP, prefersBorder: false } };
  server.registerResource(
    "places-map",
    PLACES_APP_URI,
    {
      title: "Kweli places map",
      description:
        "Map of kweli_search_places results with place cards; selecting one opens its Kweli profile card.",
      mimeType: PLACES_APP_MIME,
      _meta: uiMeta,
    },
    async () => ({
      contents: [
        {
          uri: PLACES_APP_URI,
          mimeType: PLACES_APP_MIME,
          text: PLACES_APP_HTML,
          _meta: uiMeta,
        },
      ],
    }),
  );

  server.registerTool(
    "kweli_search_places",
    {
      title: "Search places",
      description:
        "Search the Mukoko knowledge graph for places (businesses, parks, schools, NGOs, media, " +
        "government offices, landmarks: every entity type) by name and/or city. Returns compact rows: " +
        "id, name, type, city, rating, verification tier, coordinates and a Kweli link. Use first; " +
        "then kweli_get_place for one record's full detail. Name matching is a case-insensitive " +
        "substring; city matches from the start. Paginated.",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("Part of the place's name, e.g. 'Musika'."),
        city: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe("City the place is in, e.g. 'Harare'."),
        limit: limitSchema(20, 10),
        offset: offsetSchema,
      }),
      outputSchema: z.object({
        query: z.string().nullable(),
        city: z.string().nullable(),
        ...pageOutput(placeRowSchema),
        places: z
          .array(placeRowSchema)
          .describe("Same rows as items (read by the places map view)."),
      }),
      annotations: READ,
      _meta: { ui: { resourceUri: PLACES_APP_URI } },
    },
    guarded("kweli_search_places", async ({ query, city, limit, offset }) => {
      const client = await mongo();
      const filter: Record<string, unknown> = { isActive: { $ne: false } };
      if (query) filter.name = { $regex: escapeRegex(query), $options: "i" };
      if (city)
        filter["address.city"] = {
          $regex: `^${escapeRegex(city)}`,
          $options: "i",
        };
      const docs = await client
        .db(DB.places)
        .collection<PlaceDoc>(COLLECTION.places)
        .find(filter, { skip: offset, limit: limit + 1, maxTimeMS })
        .toArray();
      const hasMore = docs.length > limit;
      const rows = docs.slice(0, limit).map(placeRow);
      const body = page(rows, offset, null, hasMore, {
        query: query ?? null,
        city: city ?? null,
      });
      return jsonResult({ ...body, places: body.items });
    }),
  );

  server.registerTool(
    "kweli_get_place",
    {
      title: "Get a place",
      description:
        "Fetch one place by its id or slug: name, type, description, address, coordinates, phone and " +
        "website when present, rating, verification tier, and the Kweli verification link. Use after " +
        "kweli_search_places.",
      inputSchema: z.object({
        id: idSchema("The place's id or slug, from kweli_search_places."),
      }),
      outputSchema: z.object({
        id: z.string(),
        name: z.string(),
        type: z.array(z.string()).nullable(),
        description: z.string().nullable(),
        address: looseDoc.nullable(),
        geo: z.object({ lat: z.number(), lng: z.number() }).nullable(),
        phone: z.string().optional(),
        website: z.string().optional(),
        rating: z.unknown().nullable(),
        verification: verificationSchema,
        verifyUrl: z.string(),
        url: z.string(),
      }),
      annotations: READ,
    },
    guarded("kweli_get_place", async ({ id }) => {
      const client = await mongo();
      const col = client.db(DB.places).collection<PlaceDoc>(COLLECTION.places);
      const doc =
        (await col.findOne({ _id: id }, { maxTimeMS })) ??
        (await col.findOne({ slug: id }, { maxTimeMS }));
      if (!doc) {
        throw new ToolError(
          `kweli_get_place: no place with id or slug '${id}'. Find it with kweli_search_places first.`,
        );
      }
      return jsonResult({
        id: String(doc._id),
        name: doc.name,
        type: doc.placeType ?? null,
        description: doc.description ?? null,
        address: (doc.address as Record<string, unknown> | undefined) ?? null,
        geo: doc.geo?.coordinates
          ? { lat: doc.geo.coordinates[1], lng: doc.geo.coordinates[0] }
          : null,
        ...(doc.telephone ? { phone: doc.telephone } : {}),
        ...(doc.url ? { website: doc.url } : {}),
        rating: doc.discovery?.aggregateRating ?? null,
        verification: verificationOf(doc),
        verifyUrl: verifyPlaceUrl(String(doc._id)),
        url: placeUrl(doc._id),
      });
    }),
  );

  server.registerTool(
    "kweli_get_organization",
    {
      title: "Get an organization",
      description:
        "Fetch the public trust profile of an organization (the entity that operates places) by id or " +
        "slug: name, legal name, entity type, verification tier, Ubuntu trust score, and how many active " +
        "places it operates.",
      inputSchema: z.object({ id: idSchema("The organization's id or slug.") }),
      outputSchema: z.object({
        id: z.string(),
        name: z.string(),
        legalName: z.string().nullable(),
        slug: z.string().nullable(),
        entityType: z.string().nullable(),
        schemaOrgType: z.string().nullable(),
        placeCount: z.number().int(),
        verification: verificationSchema,
        ubuntuScore: z.number().nullable(),
        verifyUrl: z.string(),
      }),
      annotations: READ,
    },
    guarded("kweli_get_organization", async ({ id }) => {
      const client = await mongo();
      const entities = client
        .db(DB.entity)
        .collection<EntityDoc>(COLLECTION.entities);
      const doc =
        (await entities.findOne({ _id: id }, { maxTimeMS })) ??
        (await entities.findOne({ slug: id }, { maxTimeMS }));
      if (!doc) {
        throw new ToolError(
          `kweli_get_organization: no organization with id or slug '${id}'. A place's owner id is in kweli_get_place's result.`,
        );
      }
      const placeCount = await client
        .db(DB.places)
        .collection(COLLECTION.places)
        .countDocuments(
          { ownerEntityId: doc._id, isActive: { $ne: false } },
          { maxTimeMS },
        );
      return jsonResult({
        id: String(doc._id),
        name: doc.name,
        legalName: doc.legalName ?? null,
        slug: doc.slug ?? null,
        entityType: doc.entityType ?? null,
        schemaOrgType: doc.schemaOrgType ?? null,
        placeCount,
        verification: verificationOf(doc),
        ubuntuScore: doc.bundu?.trustSignals?.ubuntuScore ?? null,
        verifyUrl: verifyEntityUrl(String(doc._id)),
      });
    }),
  );

  server.registerTool(
    "kweli_get_verification",
    {
      title: "Get verification status",
      description:
        "Return the verification tier of a place OR an organization on the 5-tier Mukoko ladder " +
        "(0 unverified, 1 community/Terracotta, 2 otp/Cobalt 'Contact Verified', 3 government/Gold, " +
        "4 licensed/Tanzanite), plus the Kweli verification link. Pass exactly one of placeId or entityId.",
      inputSchema: z.object({
        placeId: idSchema("A place id.").optional(),
        entityId: idSchema("An organization id.").optional(),
      }),
      outputSchema: z.object({
        kind: z.enum(["place", "organization"]),
        id: z.string(),
        name: z.string(),
        tier: z.number().int(),
        label: z.string(),
        mineral: z.string().nullable(),
        verified: z.boolean(),
        verifyUrl: z.string(),
      }),
      annotations: READ,
    },
    guarded("kweli_get_verification", async ({ placeId, entityId }) => {
      if (Boolean(placeId) === Boolean(entityId)) {
        throw new ToolError(
          "kweli_get_verification: pass exactly one of placeId or entityId.",
        );
      }
      const client = await mongo();
      if (entityId) {
        const doc = await client
          .db(DB.entity)
          .collection<EntityDoc>(COLLECTION.entities)
          .findOne({ _id: entityId }, { maxTimeMS });
        if (!doc) {
          throw new ToolError(
            `kweli_get_verification: no organization with id '${entityId}'.`,
          );
        }
        const v = verificationOf(doc);
        return jsonResult({
          kind: "organization" as const,
          id: String(doc._id),
          name: doc.name,
          ...v,
          verified: v.tier > 0,
          verifyUrl: verifyEntityUrl(String(doc._id)),
        });
      }
      const doc = await client
        .db(DB.places)
        .collection<PlaceDoc>(COLLECTION.places)
        .findOne({ _id: placeId! }, { maxTimeMS });
      if (!doc) {
        throw new ToolError(
          `kweli_get_verification: no place with id '${placeId}'. Find it with kweli_search_places first.`,
        );
      }
      const v = verificationOf(doc);
      return jsonResult({
        kind: "place" as const,
        id: String(doc._id),
        name: doc.name,
        ...v,
        verified: v.tier > 0,
        verifyUrl: verifyPlaceUrl(String(doc._id)),
      });
    }),
  );

  server.registerTool(
    "kweli_get_open_stats",
    {
      title: "Get open graph statistics",
      description:
        "Open aggregates over the whole graph: total active places, the top 20 countries and top 10 " +
        "cities by place count, and place and organization counts per verification tier.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        totalPlaces: z.number().int(),
        byCountry: z.array(
          z.object({
            countryId: z.string().nullable(),
            count: z.number().int(),
          }),
        ),
        topCities: z.array(
          z.object({ city: z.string().nullable(), count: z.number().int() }),
        ),
        placesByTier: z.array(
          z.object({ tier: z.number().int(), count: z.number().int() }),
        ),
        organizationsByTier: z.array(
          z.object({ tier: z.number().int(), count: z.number().int() }),
        ),
      }),
      annotations: READ,
    },
    guarded("kweli_get_open_stats", async () => {
      const client = await mongo();
      const places = client.db(DB.places).collection(COLLECTION.places);
      const entities = client.db(DB.entity).collection(COLLECTION.entities);
      const active = { $match: { isActive: { $ne: false } } };
      const byTier = [
        {
          $group: {
            _id: { $ifNull: ["$bundu.verificationTier", 0] },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ];
      const [total, byCountry, topCities, placeTiers, orgTiers] =
        await Promise.all([
          places.countDocuments({ isActive: { $ne: false } }, { maxTimeMS }),
          places
            .aggregate(
              [
                active,
                { $group: { _id: "$hierarchy.countryId", count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: 20 },
              ],
              { maxTimeMS },
            )
            .toArray(),
          places
            .aggregate(
              [
                active,
                { $group: { _id: "$address.city", count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: 10 },
              ],
              { maxTimeMS },
            )
            .toArray(),
          places.aggregate(byTier, { maxTimeMS }).toArray(),
          entities.aggregate(byTier, { maxTimeMS }).toArray(),
        ]);
      const tiers = (rows: { _id: unknown; count: unknown }[]) =>
        rows.map((r) => ({ tier: Number(r._id) || 0, count: Number(r.count) }));
      return jsonResult({
        totalPlaces: total,
        byCountry: byCountry.map((r) => ({
          countryId: (r._id as string | null) ?? null,
          count: Number(r.count),
        })),
        topCities: topCities.map((r) => ({
          city: (r._id as string | null) ?? null,
          count: Number(r.count),
        })),
        placesByTier: tiers(placeTiers as never),
        organizationsByTier: tiers(orgTiers as never),
      });
    }),
  );

  return server;
}
