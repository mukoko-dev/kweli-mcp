// Skill: resolve_hierarchy. Nominatim reverse-geocode a lat/lng to country +
// province + city, then match against placesGeo records so the hierarchy
// stored on Place documents carries real placesGeo IDs rather than nulls.
//
// Nominatim usage policy: max 1 req/s, User-Agent required, no bulk crawling.
// Fundi calls this once per OSM feature during ingestion — well within limits.

import type { Db } from "mongodb";

export interface NominatimDeps {
  endpoint: string;
  fetchImpl?: typeof fetch;
}

interface NominatimAddress {
  country?: string;
  country_code?: string;
  state?: string;
  state_district?: string;
  county?: string;
  city?: string;
  town?: string;
  village?: string;
  suburb?: string;
  neighbourhood?: string;
}

interface NominatimReverseResult {
  address?: NominatimAddress;
}

export interface ResolvedHierarchy {
  countryId: string | null;
  provinceId: string | null;
  containedInPlaceId: string | null;
  countryName: string | null;
  provinceName: string | null;
  cityName: string | null;
}

const USER_AGENT = "Mukoko-Platform/1.0 (hello@nyuchi.com)";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function resolveHierarchy(
  deps: NominatimDeps,
  placesDb: Db,
  lat: number,
  lon: number,
): Promise<ResolvedHierarchy> {
  const doFetch = deps.fetchImpl ?? fetch;
  const url = `${deps.endpoint}/reverse?format=json&lat=${lat}&lon=${lon}&zoom=10&addressdetails=1`;

  const res = await doFetch(url, {
    headers: { "user-agent": USER_AGENT, "accept-language": "en" },
  });
  if (!res.ok) throw new Error(`Nominatim reverse ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as NominatimReverseResult;
  const addr = data.address ?? {};

  const countryName = addr.country ?? null;
  const countryCode = addr.country_code?.toUpperCase() ?? null;
  const provinceName = addr.state ?? addr.state_district ?? null;
  const cityName = addr.city ?? addr.town ?? addr.village ?? null;

  const col = placesDb.collection("placesGeo");

  // Country — prefer ISO code match; fall back to name match.
  let countryId: string | null = null;
  if (countryCode) {
    const doc = await col.findOne<{ _id: string }>(
      { geoType: "country", isoCode: countryCode },
      { projection: { _id: 1 } },
    );
    countryId = doc ? String(doc._id) : null;
  }
  if (!countryId && countryName) {
    const doc = await col.findOne<{ _id: string }>(
      { geoType: "country", name: { $regex: new RegExp(`^${escapeRegex(countryName)}$`, "i") } },
      { projection: { _id: 1 } },
    );
    countryId = doc ? String(doc._id) : null;
  }

  // Province — match by name under the resolved country.
  let provinceId: string | null = null;
  if (provinceName) {
    const filter: Record<string, unknown> = {
      geoType: "province",
      name: { $regex: new RegExp(escapeRegex(provinceName), "i") },
    };
    if (countryId) filter.parentPlaceId = countryId;
    const doc = await col.findOne<{ _id: string }>(filter, { projection: { _id: 1 } });
    provinceId = doc ? String(doc._id) : null;
  }

  // Nearest admin container for the POI: city first, fall back to province.
  let containedInPlaceId: string | null = null;
  if (cityName) {
    const filter: Record<string, unknown> = {
      geoType: { $in: ["city", "town", "village"] },
      name: { $regex: new RegExp(escapeRegex(cityName), "i") },
    };
    const doc = await col.findOne<{ _id: string }>(filter, { projection: { _id: 1 } });
    containedInPlaceId = doc ? String(doc._id) : provinceId;
  } else {
    containedInPlaceId = provinceId;
  }

  return { countryId, provinceId, containedInPlaceId, countryName, provinceName, cityName };
}
