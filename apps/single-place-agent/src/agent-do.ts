/**
 * SinglePlaceAgent — creates exactly one named place on request. Fills the
 * gap the cross-repo audit found: Fundi's bulk agent only does area-based
 * seeding (seed_region/seed_admin_bulk); this is the deterministic "create
 * exactly this one named place" primitive nhimbe's "create an event for
 * your company → verify this place" flow needs (a search-miss on a
 * brand-new company office shouldn't require a tile/radius sweep).
 *
 * Unlike bulk-place-agent, this runs synchronously within the request: one
 * Overpass point lookup, one Nominatim call, one Mongo write — fast enough
 * to not need a queue. `submit()` returns the final outcome directly rather
 * than a status to poll.
 *
 * Resolution order:
 *   1. Coordinates: use lat/lng directly if given, else forward-geocode
 *      `address` via Nominatim.
 *   2. A tight (~75m) Overpass lookup at that point, matched by loose name
 *      similarity — if OSM already has this place, use its real tags
 *      (richer classification) instead of guessing.
 *   3. No match → synthesize a minimal feature from just the name + point.
 *      A manual single-place request is allowed to be sparser than a
 *      bulk-ingested OSM feature; every synthetic feature defaults to
 *      LocalBusiness (the driving use case is "my company's office").
 *   4. Write via @kweli-mcp/skills' writeRecords — same tier-0,
 *      Bundu-Commons-vs-owned-entity convention as bulk ingestion.
 *
 * Synthetic (non-OSM) features get a negative numeric id — real OSM element
 * ids are always positive — so they can never collide with a genuine OSM
 * record in the shared `sourceProvenance.legacyId` dedup key.
 */

import { Agent } from "agents";
import { buildClient, DB } from "@kweli-mcp/mongo";
import { buildSink, newSpanId, parseTraceparent, Tracer } from "@kweli-mcp/telemetry";
import { encodePlusCode } from "@kweli-mcp/shared";
import {
  classify,
  overpassLookup,
  osmKey,
  resolveHierarchy,
  writeRecords,
  type OsmFeature,
} from "@kweli-mcp/skills";

export interface SinglePlaceRequest {
  name: string;
  lat?: number;
  lng?: number;
  address?: string;
  source?: { kind: string; requestedByPersonId?: string };
}

export interface SinglePlaceResult {
  taskId: string;
  status: "done" | "failed";
  placeId?: string;
  entityId?: string | null;
  error?: string;
}

export interface SinglePlaceState {
  request: SinglePlaceRequest | null;
  status: "queued" | "done" | "failed";
  result: SinglePlaceResult | null;
}

const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";
const NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org";
const USER_AGENT = "Mukoko-Platform/1.0 (hello@nyuchi.com)";
// ~75m at the equator; generous enough to catch the same building, tight
// enough that it never pulls in an unrelated neighbour.
const LOOKUP_RADIUS_DEGREES = 0.0007;

async function geocodeAddress(address: string): Promise<{ lat: number; lng: number } | null> {
  const url = `${NOMINATIM_ENDPOINT}/search?format=json&limit=1&q=${encodeURIComponent(address)}`;
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT, "accept-language": "en" } });
  if (!res.ok) throw new Error(`Nominatim search ${res.status}: ${await res.text()}`);
  const results = (await res.json()) as Array<{ lat: string; lon: string }>;
  const first = results[0];
  if (!first) return null;
  return { lat: Number(first.lat), lng: Number(first.lon) };
}

function nameMatches(requested: string, candidate: string | null): boolean {
  if (!candidate) return false;
  const a = requested.trim().toLowerCase();
  const b = candidate.trim().toLowerCase();
  return a === b || a.includes(b) || b.includes(a);
}

function synthesizeFeature(name: string, lat: number, lng: number): OsmFeature {
  // Negative, so it can never collide with a real (always-positive) OSM id.
  const id = -(Date.now() * 1000 + Math.floor(Math.random() * 1000));
  return { type: "node", id, lat, lon: lng, tags: { name } };
}

export class SinglePlaceAgent extends Agent<Env, SinglePlaceState> {
  initialState: SinglePlaceState = { request: null, status: "queued", result: null };

  /**
   * @param traceparent W3C header value from the caller, so this DO's work
   *   joins the originating request's trace. A Durable Object call is not an
   *   HTTP hop, so there are no headers to extract from — the context has to
   *   be passed explicitly or the trace breaks here.
   */
  async submit(
    request: SinglePlaceRequest,
    traceparent?: string,
  ): Promise<SinglePlaceResult> {
    const taskId = this.name; // the DO's own id (crypto.randomUUID(), set by the caller)
    const inbound = parseTraceparent(traceparent);
    const tracer = new Tracer({
      serviceName: "kweli-single-place-agent",
      instanceId: taskId,
      sink: buildSink({ env: this.env }),
      ...(inbound
        ? { context: { ...inbound, spanId: newSpanId() }, parentSpanId: inbound.spanId }
        : {}),
    });

    this.setState({ request, status: "queued", result: null });

    try {
      const result = await this.resolveAndWrite(taskId, request, tracer);
      this.setState({ request, status: "done", result });
      return result;
    } catch (e) {
      tracer.error("submit.failed", e, { taskId });
      const result: SinglePlaceResult = { taskId, status: "failed", error: "could not create place" };
      this.setState({ request, status: "failed", result });
      return result;
    }
  }

  private async resolveAndWrite(
    taskId: string,
    request: SinglePlaceRequest,
    tracer: Tracer,
  ): Promise<SinglePlaceResult> {
    let lat = request.lat;
    let lng = request.lng;
    if (lat === undefined || lng === undefined) {
      if (!request.address) {
        return { taskId, status: "failed", error: "either lat/lng or address is required" };
      }
      const geocoded = await tracer.span("geocode.address", () =>
        geocodeAddress(request.address!),
      );
      if (!geocoded) {
        return { taskId, status: "failed", error: `could not geocode address: ${request.address}` };
      }
      lat = geocoded.lat;
      lng = geocoded.lng;
    }

    const uri = this.env.MONGODB_URI;
    if (!uri) throw new Error("MONGODB_URI is not configured on the worker");
    const client = buildClient(uri);
    await client.connect();
    const placesDb = client.db(DB.places);
    const entityDb = client.db(DB.entity);

    // Best-effort: if OSM already has this exact place, use its real tags.
    let feature: OsmFeature | null = null;
    try {
      feature = await tracer.span("overpass.lookup", async () => {
        const nearby = await overpassLookup(
          { endpoint: OVERPASS_ENDPOINT },
          {
            s: lat - LOOKUP_RADIUS_DEGREES,
            w: lng - LOOKUP_RADIUS_DEGREES,
            n: lat + LOOKUP_RADIUS_DEGREES,
            e: lng + LOOKUP_RADIUS_DEGREES,
          },
          "all",
        );
        return nearby.find((f) => nameMatches(request.name, f.tags.name ?? null)) ?? null;
      });
    } catch (e) {
      // Overpass being unavailable never blocks a manual single-place
      // request — fall through to the synthetic feature.
      tracer.warn("overpass.unavailable", {
        taskId,
        "error.message": e instanceof Error ? e.message : String(e),
      });
    }

    const resolvedFeature = feature ?? synthesizeFeature(request.name, lat, lng);
    const classification = feature
      ? classify(feature)
      : { isBusiness: true, placeType: ["LocalBusiness"] as const, schemaOrgType: "LocalBusiness" as const, name: request.name };

    const hierarchy = await tracer.span("resolve.hierarchy", () =>
      resolveHierarchy({ endpoint: NOMINATIM_ENDPOINT }, placesDb, lat, lng),
    );

    const outcome = await tracer.span("mongo.write_records", () =>
      writeRecords(placesDb, entityDb, {
        feature: resolvedFeature,
        classification: { ...classification, placeType: [...classification.placeType] },
        name: request.name,
        plusCode: encodePlusCode(lat, lng, 10),
        what3words: null,
        wikidata: null,
        description: null,
        dataConfidence: feature ? 0.9 : 0.5,
        hierarchy: {
          containedInPlaceId: hierarchy.containedInPlaceId,
          countryId: hierarchy.countryId,
          provinceId: hierarchy.provinceId,
        },
      }),
    );

    tracer.info("submit.done", {
      taskId,
      osmMatch: Boolean(feature),
      osmKey: osmKey(resolvedFeature),
      ...outcome,
    });

    return { taskId, status: "done", placeId: outcome.placeId, entityId: outcome.entityId };
  }
}
