/**
 * SinglePlaceAgent — STUB. Fills the gap the cross-repo audit found: today
 * Fundi only does area-based bulk seeding (seed_region/seed_admin_bulk);
 * there is no deterministic "create exactly this one named place" primitive,
 * which nhimbe's "create an event for your company → verify this place" flow
 * needs (a search-miss on a brand-new company office shouldn't require a
 * tile/radius sweep).
 *
 * TODO (real implementation, in priority order):
 *   1. Resolve the place deterministically: prefer lat/lng if given (a tight
 *      Overpass point_radius lookup via @kweli-mcp/skills' overpassLookup,
 *      matched by name similarity to the OSM feature at that point);
 *      otherwise geocode `address` via Nominatim first (resolveHierarchy
 *      already wraps this for hierarchy — reuse its Nominatim call, or add a
 *      forward-geocode variant).
 *   2. If no OSM feature matches closely enough, still create the place from
 *      just the given name + coordinates/address — a manual single-place
 *      request is allowed to be sparser than a bulk-ingested OSM feature.
 *   3. Write via @kweli-mcp/skills' writeRecords (place + owner entity, tier
 *      0, source.kind: "ops_mcp", same Bundu-Commons-vs-owned-entity
 *      convention as bulk ingestion).
 *   4. Record the outcome in a D1 ledger (own table — do NOT write into the
 *      fundi-ingestion-tasks ledger schema, this is a different task shape)
 *      so /tasks/{taskId} (a future GET) can be polled.
 *
 * Until then, this Agent only validates input, allocates a taskId, and
 * returns `status: "not_implemented"` — real, working wiring (the service
 * binding from apps/mcp-places, the DO, the queue) with an honest stub body.
 */

import { Agent } from "agents";
import { uuidv7 } from "@kweli-mcp/shared";

export interface SinglePlaceRequest {
  name: string;
  lat?: number;
  lng?: number;
  address?: string;
  source?: { kind: string; requestedByPersonId?: string };
}

export interface SinglePlaceState {
  request: SinglePlaceRequest | null;
  status: "queued" | "not_implemented";
  taskId: string | null;
}

export class SinglePlaceAgent extends Agent<Env, SinglePlaceState> {
  initialState: SinglePlaceState = { request: null, status: "queued", taskId: null };

  async submit(request: SinglePlaceRequest): Promise<{ taskId: string; status: string }> {
    const taskId = uuidv7();
    this.setState({ request, status: "not_implemented", taskId });
    console.log(
      JSON.stringify({ worker: "kweli-single-place-agent", event: "submit.stub", taskId, name: request.name }),
    );
    return { taskId, status: "not_implemented" };
  }
}
