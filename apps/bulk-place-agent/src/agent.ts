// Fundi: the agent. Not a transform — an agent frame whose tools are *skills*.
// Today the routing is deterministic (LLM only at the description judgment
// point), but skills register into one map so richer skills (future relational /
// landmark resolution) slot in without rewriting the consumer.

import type { Db, MongoClient } from "mongodb";
import type { Tracer } from "@kweli-mcp/telemetry";
import { type Bbox, boundaryBbox, guardRegion } from "@kweli-mcp/shared";
import { DB } from "@kweli-mcp/mongo";
import { encodePlusCode } from "@kweli-mcp/shared";
import { ProviderRegistry } from "@kweli-mcp/shared";
import { classify, type OsmFeature } from "@kweli-mcp/skills";
import { type AiConfig, generateDescription } from "@kweli-mcp/skills";
import { type OverpassDeps, overpassLookup, osmKey } from "@kweli-mcp/skills";
import { type NominatimDeps, resolveHierarchy } from "@kweli-mcp/skills";
import { radiusBbox, tileBbox } from "@kweli-mcp/skills";
import { type EnrichedRecord, writeRecords } from "@kweli-mcp/skills";
import { enrichWikidata, type WikidataDeps } from "@kweli-mcp/skills";
import { resolveWhat3Words, type What3WordsConfig } from "@kweli-mcp/skills";
import type { CreatedRecord, SeedTask, TaskResult } from "@kweli-mcp/shared";

export interface AgentDeps {
  client: MongoClient;
  placesDb: Db;
  entityDb: Db;
  registry: ProviderRegistry;
  overpass: OverpassDeps;
  nominatim: NominatimDeps | null;
  ai: AiConfig | null;
  what3words: What3WordsConfig | null;
  wikidata: WikidataDeps | null;
  boundary: Bbox;
  tracer: Tracer;
}

export async function buildDeps(
  client: MongoClient,
  env: Env,
  tracer: Tracer,
): Promise<AgentDeps> {
  const strEnv = env as unknown as Record<string, string | undefined>;
  const integrationsDb = client.db(DB.integrations);
  const registry = new ProviderRegistry(integrationsDb, strEnv);

  const overpassEndpoint = await registry.endpoint("openstreetmap");
  const nominatimEndpoint = await registry.endpoint("nominatim");
  const wikidataEndpoint = await registry.endpoint("wikidata");

  const w3wEndpoint = await registry.endpoint("what3words");
  const w3wKey = await registry.credential("what3words");

  // generate_description runs on Workers AI (Kimi by default), routed through
  // the shamwari AI Gateway. No API key — the AI binding carries access.
  const aiModel = await registry.model(
    "workers_ai",
    env.FUNDI_AI_MODEL ?? "workers-ai/@cf/moonshotai/kimi-k2.6",
  );
  const aiGateway = env.FUNDI_AI_GATEWAY ?? "shamwari";

  return {
    client,
    placesDb: client.db(DB.places),
    entityDb: client.db(DB.entity),
    registry,
    overpass: { endpoint: overpassEndpoint },
    nominatim: nominatimEndpoint ? { endpoint: nominatimEndpoint } : null,
    ai: env.AI ? { binding: env.AI, model: aiModel, gateway: aiGateway } : null,
    what3words: w3wKey ? { endpoint: w3wEndpoint, apiKey: w3wKey } : null,
    wikidata: wikidataEndpoint ? { endpoint: wikidataEndpoint } : null,
    boundary: boundaryBbox(strEnv),
    tracer,
  };
}

// Resolves an `admin` region to a bbox via the places.placesGeo centroid.
async function resolveAdminBbox(
  placesDb: Db,
  adminPlaceId: string,
): Promise<{ bbox: Bbox; center: [number, number] }> {
  const doc = await placesDb.collection("placesGeo").findOne<{
    geo?: { coordinates?: [number, number] };
    center?: [number, number];
    centroid?: { coordinates?: [number, number] };
    seedRadiusMeters?: number;
    geoType?: string;
  }>({ _id: adminPlaceId as never });
  if (!doc) throw new Error(`admin region not found in places.placesGeo: ${adminPlaceId}`);

  // Country/province docs are centroid-only; a default radius around a national
  // centroid would silently cover a tiny disk while claiming country coverage.
  // Country-scale work goes through the country_settlements bulk intent.
  if (
    (doc.geoType === "country" || doc.geoType === "province") &&
    doc.seedRadiusMeters === undefined
  ) {
    throw new Error(
      `admin region ${adminPlaceId} is a ${doc.geoType} without seedRadiusMeters — ` +
        `use the country_settlements bulk intent (or set seedRadiusMeters on the doc)`,
    );
  }

  const coords = doc.geo?.coordinates ?? doc.centroid?.coordinates ?? doc.center;
  if (!coords) throw new Error(`places.placesGeo doc ${adminPlaceId} has no centroid`);
  const radius = doc.seedRadiusMeters ?? 25_000;
  return { bbox: radiusBbox(coords[0], coords[1], radius), center: coords };
}

function dataConfidence(feature: OsmFeature): number {
  const tagCount = Object.keys(feature.tags ?? {}).length;
  return Math.min(0.3 + 0.05 * tagCount, 0.9);
}

export async function runTask(task: SeedTask, deps: AgentDeps): Promise<TaskResult> {
  deps.tracer.info("task.start", { source: task.source.kind, region: task.region.kind });

  // Resolve the region to a bbox + containment hint.
  let bbox: Bbox;
  let containedInPlaceId: string | null = null;
  if (task.region.kind === "point_radius") {
    const [lng, lat] = task.region.center;
    bbox = radiusBbox(lng, lat, task.region.radiusMeters);
  } else if (task.region.kind === "bbox") {
    const [s, w, n, e] = task.region.bbox;
    bbox = { s, w, n, e };
  } else {
    const resolved = await resolveAdminBbox(deps.placesDb, task.region.adminPlaceId);
    bbox = resolved.bbox;
    containedInPlaceId = task.region.adminPlaceId;
    // Deferred Africa guard (§2): admin centroid is only known now.
    const guard = guardRegion(
      { kind: "point_radius", center: resolved.center, radiusMeters: 1 },
      deps.boundary,
    );
    if (!guard.ok) throw new Error(`boundary guard: ${guard.reason}`);
  }

  const tiles = tileBbox(bbox);
  deps.tracer.info("tile.done", { tiles: tiles.length });

  // Dedupe on OSM id across tiles; keep the richest element (most tags).
  const seen = new Map<string, OsmFeature>();
  for (const tile of tiles) {
    let features: OsmFeature[] = [];
    try {
      features = await overpassLookup(deps.overpass, tile, task.categories);
    } catch (e) {
      deps.tracer.warn("overpass.error", { error: String(e) });
      continue;
    }
    for (const f of features) {
      const key = osmKey(f);
      const prev = seen.get(key);
      if (!prev || Object.keys(f.tags).length > Object.keys(prev.tags).length) seen.set(key, f);
    }
  }
  deps.tracer.info("overpass.done", { uniqueFeatures: seen.size });

  let placesCreated = 0;
  let entitiesCreated = 0;
  let skipped = 0;
  const records: CreatedRecord[] = [];

  for (const feature of seen.values()) {
    const classification = classify(feature);
    if (!classification.name) {
      skipped++;
      continue;
    }

    const [plusCode, what3words, wikidata] = await Promise.all([
      Promise.resolve(encodePlusCodeSafe(feature)),
      resolveWhat3Words(deps.what3words, feature.lat, feature.lon),
      enrichWikidata(deps.wikidata, feature.tags.wikidata),
    ]);

    // LLM only when OSM has no usable description (§4 judgment point).
    const existing = feature.tags.description;
    const description =
      existing && existing.length >= 20
        ? existing
        : await generateDescription(deps.ai, feature, classification.name);

    let hierarchy = { containedInPlaceId, countryId: null as string | null, provinceId: null as string | null };
    if (deps.nominatim) {
      try {
        const resolved = await resolveHierarchy(deps.nominatim, deps.placesDb, feature.lat, feature.lon);
        hierarchy = {
          containedInPlaceId: resolved.containedInPlaceId ?? containedInPlaceId,
          countryId: resolved.countryId,
          provinceId: resolved.provinceId,
        };
      } catch (e) {
        deps.tracer.warn("hierarchy.error", { osm: osmKey(feature), error: String(e) });
      }
    }

    const rec: EnrichedRecord = {
      feature,
      classification,
      name: classification.name,
      plusCode,
      what3words,
      wikidata,
      description,
      dataConfidence: dataConfidence(feature),
      hierarchy,
    };

    try {
      const outcome = await writeRecords(deps.placesDb, deps.entityDb, rec);
      if (outcome.placeCreated) placesCreated++;
      if (outcome.entityCreated) entitiesCreated++;
      if (!outcome.placeCreated) skipped++;
      records.push({
        placeId: outcome.placeId,
        entityId: outcome.entityId,
        osmId: osmKey(feature),
        name: classification.name,
        placeCreated: outcome.placeCreated,
        entityCreated: outcome.entityCreated,
      });
    } catch (e) {
      deps.tracer.warn("write.error", { osm: osmKey(feature), error: String(e) });
      skipped++;
    }
  }

  const result: TaskResult = { placesCreated, entitiesCreated, skipped, records };
  deps.tracer.info("task.done", { ...result });
  return result;
}

function encodePlusCodeSafe(feature: OsmFeature): string {
  return encodePlusCode(feature.lat, feature.lon);
}
