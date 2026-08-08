import type { Region } from "./types";

// §0.4 / §2: Africa is the boundary *guard*, not a crawl plan. The engine is
// region-agnostic; this check is config-driven so the boundary lifts to global
// by changing FUNDI_BOUNDARY_BBOX, never by touching the engine.

export interface Bbox {
  s: number;
  w: number;
  n: number;
  e: number;
}

// Thrown when a region falls outside the ingestion boundary. The submit handler
// maps this to a clean 4xx without echoing internal exception text.
export class BoundaryGuardError extends Error {
  constructor(reason: string) {
    super(`boundary guard rejected region: ${reason}`);
    this.name = "BoundaryGuardError";
  }
}

// Generous continental envelope for Africa (incl. nearby islands).
const DEFAULT_AFRICA_BBOX: Bbox = { s: -36, w: -26, n: 38, e: 64 };

export function boundaryBbox(env: { FUNDI_BOUNDARY_BBOX?: string }): Bbox {
  const raw = env.FUNDI_BOUNDARY_BBOX?.trim();
  if (!raw) return DEFAULT_AFRICA_BBOX;
  const parts = raw.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`FUNDI_BOUNDARY_BBOX must be "s,w,n,e"; got "${raw}"`);
  }
  const [s, w, n, e] = parts;
  return { s, w, n, e };
}

function pointInside(b: Bbox, lat: number, lng: number): boolean {
  return lat >= b.s && lat <= b.n && lng >= b.w && lng <= b.e;
}

export interface GuardResult {
  ok: boolean;
  reason?: string;
  deferred?: boolean;
}

// Validates that a region falls within the boundary. `admin` regions cannot be
// checked until their centroid is resolved from places.placesGeo, so they are
// deferred to the consumer (which re-checks after resolution).
export function guardRegion(region: Region, bbox: Bbox): GuardResult {
  if (region.kind === "point_radius") {
    const [lng, lat] = region.center;
    if (!pointInside(bbox, lat, lng)) {
      return { ok: false, reason: `point ${lat},${lng} is outside the ingestion boundary` };
    }
    return { ok: true };
  }
  if (region.kind === "bbox") {
    const [s, w, n, e] = region.bbox;
    const corners: Array<[number, number]> = [
      [s, w],
      [s, e],
      [n, w],
      [n, e],
    ];
    const outside = corners.some(([lat, lng]) => !pointInside(bbox, lat, lng));
    if (outside) {
      return { ok: false, reason: `bbox ${region.bbox.join(",")} extends outside the boundary` };
    }
    return { ok: true };
  }
  return { ok: true, deferred: true };
}
