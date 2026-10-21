// Kweli's country scope: Africa plus every emerging and developing economy.
//
// Owner decision 2026-10-20: the scope is the IMF's "emerging market and
// developing economies" group, i.e. every country EXCEPT the IMF's advanced
// economies. It is written as that exclusion list because the IMF publishes the
// advanced group as the short, explicit list; the other group is "everyone else".
//
// Source: IMF World Economic Outlook, country composition (41 advanced
// economies). When the IMF reclassifies a country, change this list and its test.
//
// The bbox in africa.ts stays as a coarse envelope. This is the real guard: a
// point is in scope when the country it falls in is in scope.

export const IMF_ADVANCED_ECONOMIES: ReadonlySet<string> = new Set([
  "AD", // Andorra
  "AT", // Austria
  "AU", // Australia
  "BE", // Belgium
  "CA", // Canada
  "CH", // Switzerland
  "CY", // Cyprus
  "CZ", // Czech Republic
  "DE", // Germany
  "DK", // Denmark
  "EE", // Estonia
  "ES", // Spain
  "FI", // Finland
  "FR", // France
  "GB", // United Kingdom
  "GR", // Greece
  "HK", // Hong Kong SAR
  "HR", // Croatia
  "IE", // Ireland
  "IL", // Israel
  "IS", // Iceland
  "IT", // Italy
  "JP", // Japan
  "KR", // Korea
  "LT", // Lithuania
  "LU", // Luxembourg
  "LV", // Latvia
  "MO", // Macao SAR
  "MT", // Malta
  "NL", // Netherlands
  "NO", // Norway
  "NZ", // New Zealand
  "PR", // Puerto Rico
  "PT", // Portugal
  "SE", // Sweden
  "SG", // Singapore
  "SI", // Slovenia
  "SK", // Slovak Republic
  "SM", // San Marino
  "TW", // Taiwan Province of China
  "US", // United States
]);

// Nominatim and placesGeo both use ISO 3166-1 alpha-2. Territories carry their
// own code (Réunion is RE, Mayotte YT), so African territories of an advanced
// economy are in scope, as Africa always is.
export function countryInScope(isoCode: string | null | undefined): boolean {
  if (!isoCode) return false;
  return !IMF_ADVANCED_ECONOMIES.has(isoCode.trim().toUpperCase());
}

export interface CountryLookupDeps {
  endpoint: string;
  fetchImpl?: typeof fetch;
}

const USER_AGENT = "Mukoko-Platform/1.0 (hello@nyuchi.com)";

// The ISO country code at a point, from Nominatim at country zoom. Returns null
// when the point is in no country (open sea) or the lookup fails; callers decide
// what a null means, it is never treated as "in scope".
export async function countryAt(
  deps: CountryLookupDeps,
  lat: number,
  lon: number,
): Promise<string | null> {
  const doFetch = deps.fetchImpl ?? fetch;
  const url = `${deps.endpoint}/reverse?format=json&lat=${lat}&lon=${lon}&zoom=3&addressdetails=1`;
  const res = await doFetch(url, {
    headers: { "user-agent": USER_AGENT, "accept-language": "en" },
  });
  if (!res.ok) throw new Error(`Nominatim reverse ${res.status}`);
  const data = (await res.json()) as {
    address?: { country_code?: string };
  };
  return data.address?.country_code?.toUpperCase() ?? null;
}
