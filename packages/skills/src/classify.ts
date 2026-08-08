// Skill: classify_place_and_entity (§4.7). From OSM tags decide whether a
// feature is a business (→ place + unverified entity) or a natural/owner-less
// place (→ place owned by Bundu Commons). Maps tags → placeType[] + schemaOrgType.
//
// Pure and dependency-free so it is unit-testable and never touches the driver.

export interface OsmFeature {
  type: "node" | "way" | "relation";
  id: number;
  lat: number;
  lon: number;
  tags: Record<string, string>;
}

// places.places `placeType` enum (schema v3.2).
export type PlaceType =
  | "LocalBusiness"
  | "TouristAttraction"
  | "Park"
  | "Beach"
  | "Mountain"
  | "Lake"
  | "River"
  | "Landform"
  | "Place"
  | "Accommodation"
  | "CivicStructure"
  | "Residence"
  | "Restaurant"
  | "Store";

// entity.entities `schemaOrgType` enum (subset we emit).
export type SchemaOrgType =
  | "LocalBusiness"
  | "Organization"
  | "NewsMediaOrganization"
  | "RadioStation"
  | "TelevisionStation";

export interface Classification {
  isBusiness: boolean;
  placeType: PlaceType[];
  schemaOrgType: SchemaOrgType;
  name: string | null;
}

const ACCOMMODATION_TOURISM = new Set([
  "hotel",
  "guest_house",
  "hostel",
  "motel",
  "chalet",
  "apartment",
  "camp_site",
  "caravan_site",
]);

const ATTRACTION_TOURISM = new Set([
  "attraction",
  "viewpoint",
  "museum",
  "artwork",
  "gallery",
  "zoo",
  "theme_park",
  "aquarium",
]);

const FOOD_AMENITY = new Set(["restaurant", "cafe", "fast_food", "pub", "bar", "biergarten"]);

const BUSINESS_AMENITY = new Set([
  "bank",
  "pharmacy",
  "fuel",
  "clinic",
  "hospital",
  "marketplace",
  "cinema",
  "nightclub",
  "car_rental",
  "bureau_de_change",
]);

function pickName(tags: Record<string, string>): string | null {
  return tags.name || tags["name:en"] || tags.official_name || tags.brand || null;
}

function dedupe(types: PlaceType[]): PlaceType[] {
  return Array.from(new Set(types));
}

export function classify(feature: OsmFeature): Classification {
  const t = feature.tags ?? {};
  const name = pickName(t);

  // ---- Natural / owner-less places (Bundu Commons custodian) ----
  if (t.natural === "peak" || t.natural === "volcano" || t.natural === "ridge") {
    return {
      isBusiness: false,
      placeType: ["Mountain", "Landform"],
      schemaOrgType: "Organization",
      name,
    };
  }
  if (t.natural === "beach") {
    return { isBusiness: false, placeType: ["Beach"], schemaOrgType: "Organization", name };
  }
  if (t.waterway === "waterfall" || t.natural === "waterfall") {
    return {
      isBusiness: false,
      placeType: ["TouristAttraction", "Landform"],
      schemaOrgType: "Organization",
      name,
    };
  }
  if (t.natural === "water" || t.water === "lake" || t.landuse === "reservoir") {
    return { isBusiness: false, placeType: ["Lake"], schemaOrgType: "Organization", name };
  }
  if (t.waterway === "river" || t.waterway === "stream") {
    return { isBusiness: false, placeType: ["River"], schemaOrgType: "Organization", name };
  }
  if (
    t.leisure === "park" ||
    t.leisure === "nature_reserve" ||
    t.boundary === "national_park" ||
    t.boundary === "protected_area"
  ) {
    return { isBusiness: false, placeType: ["Park"], schemaOrgType: "Organization", name };
  }
  if (t.natural || t.geological) {
    return { isBusiness: false, placeType: ["Landform"], schemaOrgType: "Organization", name };
  }

  // ---- Businesses (place + unverified entity) ----
  if (t.tourism && ACCOMMODATION_TOURISM.has(t.tourism)) {
    return {
      isBusiness: true,
      placeType: dedupe(["Accommodation", "LocalBusiness"]),
      schemaOrgType: "LocalBusiness",
      name,
    };
  }
  if (t.amenity && FOOD_AMENITY.has(t.amenity)) {
    return {
      isBusiness: true,
      placeType: dedupe(["Restaurant", "LocalBusiness"]),
      schemaOrgType: "LocalBusiness",
      name,
    };
  }
  if (t.shop) {
    return {
      isBusiness: true,
      placeType: dedupe(["Store", "LocalBusiness"]),
      schemaOrgType: "LocalBusiness",
      name,
    };
  }
  if (t.tourism && ATTRACTION_TOURISM.has(t.tourism)) {
    // Attractions are visitable places; treat as owner-less unless clearly run
    // as a business (museum/zoo/theme_park often are).
    const operated =
      t.tourism === "museum" ||
      t.tourism === "zoo" ||
      t.tourism === "theme_park" ||
      t.tourism === "aquarium";
    return {
      isBusiness: operated,
      placeType: operated ? dedupe(["TouristAttraction", "LocalBusiness"]) : ["TouristAttraction"],
      schemaOrgType: "LocalBusiness",
      name,
    };
  }
  if (t.amenity && BUSINESS_AMENITY.has(t.amenity)) {
    return {
      isBusiness: true,
      placeType: dedupe(["LocalBusiness", "CivicStructure"]),
      schemaOrgType: "LocalBusiness",
      name,
    };
  }
  if (t.office || t.craft) {
    return { isBusiness: true, placeType: ["LocalBusiness"], schemaOrgType: "Organization", name };
  }
  if (
    t.amenity === "place_of_worship" ||
    t.amenity === "townhall" ||
    t.amenity === "school" ||
    t.amenity === "university"
  ) {
    return {
      isBusiness: false,
      placeType: ["CivicStructure"],
      schemaOrgType: "Organization",
      name,
    };
  }

  return { isBusiness: false, placeType: ["Place"], schemaOrgType: "Organization", name };
}
