// Skill: write_records (§4.8 + §7). Upsert to places.places (+ a linked,
// unverified entity.entities when the feature is a business). Idempotent on the
// OSM id, so re-running a task never duplicates. Tier 0, always.
//
// Numeric typing (§7, learned the hard way): emit real BSON types — doubles via
// `Double`, counts as plain JS integers (the driver serialises them as int32).
// Never use Extended JSON $number wrappers.

import { type Db, Double } from "mongodb";
import { BUNDU_COMMONS_ID, SCHEMA_VERSION } from "@kweli-mcp/mongo";
import { uuidv7 } from "@kweli-mcp/shared";
import type { Classification, OsmFeature } from "./classify";
import { osmKey } from "./overpass";
import type { WikidataEnrichment } from "./wikidata";

export interface EnrichedRecord {
  feature: OsmFeature;
  classification: Classification;
  name: string;
  plusCode: string;
  what3words: string | null;
  wikidata: WikidataEnrichment | null;
  description: string | null;
  dataConfidence: number;
  hierarchy: {
    containedInPlaceId: string | null;
    countryId: string | null;
    provinceId: string | null;
  };
}

export interface WriteOutcome {
  placeId: string;
  entityId: string | null; // null for natural / Bundu-Commons-owned places
  placeCreated: boolean;
  entityCreated: boolean;
}

function slugify(name: string, idSuffix: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "place"}-${idSuffix}`;
}

function addressFromTags(tags: Record<string, string>): Record<string, string> | null {
  const map: Record<string, string> = {};
  if (tags["addr:street"]) map.street = tags["addr:street"];
  if (tags["addr:housenumber"]) map.houseNumber = tags["addr:housenumber"];
  if (tags["addr:city"]) map.city = tags["addr:city"];
  if (tags["addr:postcode"]) map.postalCode = tags["addr:postcode"];
  if (tags["addr:country"]) map.country = tags["addr:country"];
  return Object.keys(map).length ? map : null;
}

export async function writeRecords(
  placesDb: Db,
  entityDb: Db,
  rec: EnrichedRecord,
): Promise<WriteOutcome> {
  const legacyId = osmKey(rec.feature);
  const now = new Date();
  const coordinates: [number, number] = [rec.feature.lon, rec.feature.lat];

  let ownerEntityId = BUNDU_COMMONS_ID;
  let placeId = uuidv7();
  let entityCreated = false;

  if (rec.classification.isBusiness) {
    const entities = entityDb.collection("entities");
    const candidateEntityId = uuidv7();
    const entityFilter = { "sourceProvenance.legacyId": legacyId, entityType: "organization" };

    const entitySet: Record<string, unknown> = {
      _schemaVersion: SCHEMA_VERSION,
      entityType: "organization",
      ecosystemRole: "external",
      schemaOrgType: rec.classification.schemaOrgType,
      name: rec.name,
      slug: slugify(rec.name, candidateEntityId.slice(-6)),
      isActive: true,
      isPrivateByDefault: false,
      updatedAt: now,
      bundu: {
        verificationTier: 0,
        trustSignals: {
          ubuntuScore: new Double(0),
          communityVouches: 0,
          reviewCount: 0,
          scamReportCount: 0,
          scamReportResolved: 0,
          verificationTier: 0,
        },
      },
      sourceProvenance: { legacyId, sourceProject: "fundi", mirroredFrom: "osm" },
    };

    const entityRes = await entities.updateOne(
      entityFilter,
      {
        $setOnInsert: { _id: candidateEntityId as never, primaryPlaceId: placeId, createdAt: now },
        $set: entitySet,
      },
      { upsert: true },
    );

    if (entityRes.upsertedCount > 0) {
      ownerEntityId = candidateEntityId;
      entityCreated = true;
    } else {
      const existing = await entities.findOne<{ _id: string; primaryPlaceId?: string }>(
        entityFilter,
        {
          projection: { _id: 1, primaryPlaceId: 1 },
        },
      );
      ownerEntityId = (existing?._id as string) ?? candidateEntityId;
      placeId = existing?.primaryPlaceId ?? placeId;
    }
  }

  // ---- place ----
  const places = placesDb.collection("places");
  const placeFilter = {
    "sourceProvenance.legacyId": legacyId,
    "sourceProvenance.dataOrigin": "osm",
  };

  const placeSet: Record<string, unknown> = {
    _schemaVersion: SCHEMA_VERSION,
    ownerEntityId,
    name: rec.name,
    slug: slugify(rec.name, placeId.slice(-6)),
    geo: { type: "Point", coordinates },
    placeType: rec.classification.placeType,
    plusCode: rec.plusCode,
    isActive: true,
    updatedAt: now,
    hierarchy: rec.hierarchy,
    bundu: {
      verificationTier: 0,
      trustSignals: { ubuntuScore: new Double(0), communityVouches: 0, reviewCount: 0 },
      informalEconomy: { isInformal: false },
      communityCaretakers: [],
      osmContribution: { osmType: rec.feature.type, osmId: rec.feature.id, lastSyncedAt: now },
    },
    sourceProvenance: {
      legacyId,
      dataOrigin: "osm",
      dataConfidence: new Double(rec.dataConfidence),
    },
  };

  if (rec.what3words) placeSet.what3words = rec.what3words;
  if (rec.description) placeSet.content = { description: rec.description };
  const address = addressFromTags(rec.feature.tags);
  if (address) placeSet.address = address;
  if (rec.wikidata) {
    placeSet.identifiers = rec.wikidata.identifiers;
    placeSet.sameAs = rec.wikidata.sameAs;
  }

  const placeRes = await places.updateOne(
    placeFilter,
    { $setOnInsert: { _id: placeId as never, createdAt: now }, $set: placeSet },
    { upsert: true },
  );

  return {
    placeId,
    entityId: rec.classification.isBusiness ? ownerEntityId : null,
    placeCreated: placeRes.upsertedCount > 0,
    entityCreated,
  };
}
