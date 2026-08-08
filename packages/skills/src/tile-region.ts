// Skill: tile_region (§4.1). Turn a task region into Overpass query tiles.
// Continental coverage must never assume a single Overpass call, so large areas
// are split into bounded tiles. Pure: admin regions are resolved to a bbox by
// the agent (via places.placesGeo) before tiling.

import type { Bbox } from "@kweli-mcp/shared";

export type Tile = Bbox;

// ~0.25° ≈ 28 km at the equator. Conservative so Overpass stays happy.
const MAX_TILE_DEG = 0.25;

const EARTH_RADIUS_M = 6_378_137;

export function radiusBbox(centerLng: number, centerLat: number, radiusMeters: number): Bbox {
  const dLat = (radiusMeters / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLng =
    (radiusMeters / (EARTH_RADIUS_M * Math.cos((centerLat * Math.PI) / 180))) * (180 / Math.PI);
  return {
    s: centerLat - dLat,
    n: centerLat + dLat,
    w: centerLng - dLng,
    e: centerLng + dLng,
  };
}

export function tileBbox(bbox: Bbox, maxTileDeg = MAX_TILE_DEG): Tile[] {
  const tiles: Tile[] = [];
  const latSpan = bbox.n - bbox.s;
  const lngSpan = bbox.e - bbox.w;
  const rows = Math.max(1, Math.ceil(latSpan / maxTileDeg));
  const cols = Math.max(1, Math.ceil(lngSpan / maxTileDeg));
  const latStep = latSpan / rows;
  const lngStep = lngSpan / cols;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.push({
        s: bbox.s + r * latStep,
        n: bbox.s + (r + 1) * latStep,
        w: bbox.w + c * lngStep,
        e: bbox.w + (c + 1) * lngStep,
      });
    }
  }
  return tiles;
}
