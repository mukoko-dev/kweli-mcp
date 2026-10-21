// Fundi: the agent. Not a transform — an agent frame whose tools are *skills*.
// Today the routing is deterministic (LLM only at the description judgment
// point), but skills register into one map so richer skills (future relational /
// landmark resolution) slot in without rewriting the consumer.

import type { Db, MongoClient } from "mongodb";
import type { Tracer } from "@kweli-mcp/telemetry";
import { reserveAiRequest } from "./ai-budget";
import { AGENT_NAME, chatSpanFor } from "./tracing";
import {
  type Bbox,
  BoundaryGuardError,
  boundaryBbox,
  countryAt,
  countryInScope,
  guardRegion,
} from "@kweli-mcp/shared";
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

  // generate_description runs on Workers AI through the `fundi` AI Gateway —
  // the gateway for background agents and pipelines (no guardrails, no
  // cache). Consumer-triggered chat stays on Shamwari; this is not that. No
  // API key — the AI binding is pre-authenticated, even against an
  // authenticated gateway.
  //
  // FUNDI_AI_ROUTE (a gateway dynamic route) is preferred when set; the model
  // below is the direct fallback, used while the route is not configured.
  const aiModel = await registry.model(
    "workers_ai",
    env.FUNDI_AI_MODEL ?? "@cf/qwen/qwen3-30b-a3b-fp8",
  );
  const aiRoute = env.FUNDI_AI_ROUTE || undefined;
  const aiGateway = env.FUNDI_AI_GATEWAY ?? "fundi";

  return {
    client,
    placesDb: client.db(DB.places),
    entityDb: client.db(DB.entity),
    registry,
    overpass: { endpoint: overpassEndpoint },
    nominatim: nominatimEndpoint ? { endpoint: nominatimEndpoint } : null,
    ai: env.AI
      ? {
          binding: env.AI,
          model: aiModel,
          route: aiRoute,
          gateway: aiGateway,
          metadata: { worker: AGENT_NAME, job: "generate_description" },
          reserve: () => reserveAiRequest(env),
        }
      : null,
    what3words: w3wKey ? { endpoint: w3wEndpoint, apiKey: w3wKey } : null,
    wikidata: wikidataEndpoint ? { endpoint: wikidataEndpoint } : null,
    boundary: boundaryBbox(strEnv),
    tracer,
  };
}

interface GeoDoc {
  geo?: { coordinates?: [number, number] };
  center?: [number, number];
  centroid?: { coordinates?: [number, number] };
  seedRadiusMeters?: number;
  geoType?: string;
  isoCode?: string;
  parentPlaceId?: string;
}

// The ISO code of the country an admin region sits in, walking parentPlaceId
// up from the region itself. Null when the chain reaches no country.
async function adminCountryIso(
  placesDb: Db,
  doc: GeoDoc,
): Promise<string | null> {
  let cur: GeoDoc | null = doc;
  for (let depth = 0; cur && depth < 8; depth++) {
    if (cur.geoType === "country") return cur.isoCode ?? null;
    if (!cur.parentPlaceId) return null;
    cur = await placesDb
      .collection("placesGeo")
      .findOne<GeoDoc>(
        { _id: cur.parentPlaceId as never },
        { projection: { geoType: 1, isoCode: 1, parentPlaceId: 1 } },
      );
  }
  return null;
}

// Resolves an `admin` region to a bbox via the places.placesGeo centroid.
async function resolveAdminBbox(
  placesDb: Db,
  adminPlaceId: string,
): Promise<{
  bbox: Bbox;
  center: [number, number];
  countryIso: string | null;
}> {
  const doc = await placesDb
    .collection("placesGeo")
    .findOne<GeoDoc>({ _id: adminPlaceId as never });
  if (!doc)
    throw new Error(
      `admin region not found in places.placesGeo: ${adminPlaceId}`,
    );

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

  const coords =
    doc.geo?.coordinates ?? doc.centroid?.coordinates ?? doc.center;
  if (!coords)
    throw new Error(`places.placesGeo doc ${adminPlaceId} has no centroid`);
  const radius = doc.seedRadiusMeters ?? 25_000;
  return {
    bbox: radiusBbox(coords[0], coords[1], radius),
    center: coords,
    countryIso: await adminCountryIso(placesDb, doc),
  };
}

function dataConfidence(feature: OsmFeature): number {
  const tagCount = Object.keys(feature.tags ?? {}).length;
  return Math.min(0.3 + 0.05 * tagCount, 0.9);
}

export async function runTask(
  task: SeedTask,
  deps: AgentDeps,
): Promise<TaskResult> {
  deps.tracer.info("task.start", {
    source: task.source.kind,
    region: task.region.kind,
  });

  // Resolve the region to a bbox + containment hint.
  let bbox: Bbox;
  let containedInPlaceId: string | null = null;
  if (task.region.kind === "point_radius" || task.region.kind === "bbox") {
    if (task.region.kind === "point_radius") {
      const [lng, lat] = task.region.center;
      bbox = radiusBbox(lng, lat, task.region.radiusMeters);
    } else {
      const [s, w, n, e] = task.region.bbox;
      bbox = { s, w, n, e };
    }
    await guardRegionCountry(deps, bbox);
  } else {
    const resolved = await resolveAdminBbox(
      deps.placesDb,
      task.region.adminPlaceId,
    );
    bbox = resolved.bbox;
    containedInPlaceId = task.region.adminPlaceId;
    // Deferred Africa guard (§2): admin centroid is only known now.
    const guard = guardRegion(
      { kind: "point_radius", center: resolved.center, radiusMeters: 1 },
      deps.boundary,
    );
    if (!guard.ok) throw new BoundaryGuardError(guard.reason ?? "outside");
    if (!countryInScope(resolved.countryIso)) {
      throw new BoundaryGuardError(
        `admin region ${task.region.adminPlaceId} is in ${resolved.countryIso ?? "no known country"}, outside the Kweli country scope`,
      );
    }
  }

  // Every model call in this task gets a metadata-only `chat` span.
  const ai = deps.ai ? { ...deps.ai, span: chatSpanFor(task.taskId) } : null;

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
      if (!prev || Object.keys(f.tags).length > Object.keys(prev.tags).length)
        seen.set(key, f);
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

    // LLM only when OSM has no usable description (§4 judgment point), and
    // only once per place: a re-seeded region keeps the description the place
    // already carries instead of paying the model to write it again.
    const existing = feature.tags.description;
    const description =
      existing && existing.length >= 20
        ? existing
        : ((await storedDescription(deps.placesDb, feature)) ??
          (await generateDescription(ai, feature, classification.name)));

    let hierarchy = {
      containedInPlaceId,
      countryId: null as string | null,
      provinceId: null as string | null,
    };
    if (deps.nominatim) {
      try {
        const resolved = await resolveHierarchy(
          deps.nominatim,
          deps.placesDb,
          feature.lat,
          feature.lon,
        );
        // A region near a border can reach into an advanced economy; those
        // places are outside the Kweli scope and are not written.
        if (resolved.countryCode && !countryInScope(resolved.countryCode)) {
          skipped++;
          continue;
        }
        hierarchy = {
          containedInPlaceId: resolved.containedInPlaceId ?? containedInPlaceId,
          countryId: resolved.countryId,
          provinceId: resolved.provinceId,
        };
      } catch (e) {
        deps.tracer.warn("hierarchy.error", {
          osm: osmKey(feature),
          error: String(e),
        });
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
      deps.tracer.warn("write.error", {
        osm: osmKey(feature),
        error: String(e),
      });
      skipped++;
    }
  }

  const result: TaskResult = {
    placesCreated,
    entitiesCreated,
    skipped,
    records,
  };
  deps.tracer.info("task.done", { ...result });
  return result;
}

// Country scope check for point and bbox regions, made once on the region's
// centre before any Overpass call. Fails closed: with no Nominatim endpoint the
// check cannot run, so the task is refused rather than run unchecked. A centre
// in no country (open sea off a coast) passes; each place is still checked.
async function guardRegionCountry(deps: AgentDeps, bbox: Bbox): Promise<void> {
  if (!deps.nominatim) {
    throw new BoundaryGuardError(
      "country scope check unavailable: no Nominatim endpoint configured",
    );
  }
  const lat = (bbox.s + bbox.n) / 2;
  const lon = (bbox.w + bbox.e) / 2;
  let iso: string | null;
  try {
    iso = await countryAt(deps.nominatim, lat, lon);
  } catch (e) {
    // A lookup outage must not fail the task; each place is checked below.
    deps.tracer.warn("scope.lookup_error", { error: String(e) });
    return;
  }
  if (iso && !countryInScope(iso)) {
    throw new BoundaryGuardError(
      `region centre ${lat},${lon} is in ${iso}, outside the Kweli country scope`,
    );
  }
}

// The description a previous run already wrote for this OSM feature, if any.
// Same filter as the place upsert in write-records, so it hits the same index.
async function storedDescription(
  placesDb: Db,
  feature: OsmFeature,
): Promise<string | null> {
  try {
    const doc = await placesDb.collection("places").findOne<{
      content?: { description?: unknown };
    }>(
      {
        "sourceProvenance.legacyId": osmKey(feature),
        "sourceProvenance.dataOrigin": "osm",
      },
      { projection: { _id: 0, "content.description": 1 } },
    );
    const d = doc?.content?.description;
    return typeof d === "string" && d.length >= 20 ? d : null;
  } catch {
    // A failed lookup falls through to generation, as before this check.
    return null;
  }
}

function encodePlusCodeSafe(feature: OsmFeature): string {
  return encodePlusCode(feature.lat, feature.lon);
}
