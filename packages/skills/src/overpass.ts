// Skill: overpass_lookup (§4.2). Query OSM/Overpass for features in a tile by
// category. Reuses the proven query style (node+way, `out tags center`). The
// agent dedupes on OSM id across tiles; within a result set we keep the richest
// element (most tags) so the duplicate "Rhino Safari Camp" bug never returns.

import type { Bbox } from "@kweli-mcp/shared";
import type { OsmFeature } from "./classify";

interface CategoryFilter {
  key: string;
  regex: string; // OSM value regex, or ".*" for "any value"
}

const CATEGORY_FILTERS: Record<string, CategoryFilter[]> = {
  accommodation: [
    {
      key: "tourism",
      regex: "hotel|guest_house|hostel|motel|chalet|apartment|camp_site|caravan_site",
    },
  ],
  food: [{ key: "amenity", regex: "restaurant|cafe|fast_food|pub|bar|biergarten" }],
  shop: [{ key: "shop", regex: ".+" }],
  attraction: [
    {
      key: "tourism",
      regex: "attraction|viewpoint|museum|artwork|gallery|zoo|theme_park|aquarium",
    },
  ],
  natural: [
    { key: "natural", regex: "peak|volcano|beach|water|waterfall|spring|ridge" },
    { key: "waterway", regex: "waterfall|river" },
  ],
  park: [
    { key: "leisure", regex: "park|nature_reserve" },
    { key: "boundary", regex: "national_park|protected_area" },
  ],
  civic: [
    {
      key: "amenity",
      regex:
        "place_of_worship|school|university|townhall|hospital|clinic|bank|pharmacy|marketplace",
    },
  ],
};

export const ALL_CATEGORIES = Object.keys(CATEGORY_FILTERS);

const USER_AGENT = "Mukoko-Platform/1.0 (hello@nyuchi.com)";

function resolveFilters(categories: string[] | "all"): CategoryFilter[] {
  const keys = categories === "all" ? ALL_CATEGORIES : categories;
  const filters: CategoryFilter[] = [];
  for (const key of keys) {
    const f = CATEGORY_FILTERS[key];
    if (f) filters.push(...f);
  }
  // Unknown categories collapse to nothing; default to the full taxonomy so a
  // task never silently no-ops on a typo.
  return filters.length ? filters : ALL_CATEGORIES.flatMap((k) => CATEGORY_FILTERS[k]);
}

export function buildOverpassQuery(bbox: Bbox, categories: string[] | "all"): string {
  const { s, w, n, e } = bbox;
  const box = `${s},${w},${n},${e}`;
  const lines: string[] = [];
  for (const f of resolveFilters(categories)) {
    const sel = f.regex === ".+" ? `["${f.key}"]` : `["${f.key}"~"^(${f.regex})$"]`;
    lines.push(`  node${sel}(${box});`);
    lines.push(`  way${sel}(${box});`);
  }
  return `[out:json][timeout:60];\n(\n${lines.join("\n")}\n);\nout tags center;`;
}

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export interface OverpassDeps {
  endpoint: string;
  fetchImpl?: typeof fetch;
}

export async function overpassLookup(
  deps: OverpassDeps,
  bbox: Bbox,
  categories: string[] | "all",
): Promise<OsmFeature[]> {
  const query = buildOverpassQuery(bbox, categories);
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(deps.endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!res.ok) {
    throw new Error(`Overpass ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { elements?: OverpassElement[] };
  const out: OsmFeature[] = [];
  for (const el of data.elements ?? []) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat === undefined || lon === undefined) continue;
    if (!el.tags || Object.keys(el.tags).length === 0) continue;
    out.push({ type: el.type, id: el.id, lat, lon, tags: el.tags });
  }
  return out;
}

// Stable OSM identity across node/way/relation namespaces — the dedupe key.
export function osmKey(feature: Pick<OsmFeature, "type" | "id">): string {
  return `${feature.type}/${feature.id}`;
}
