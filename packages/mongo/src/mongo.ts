import { MongoClient, type MongoClientOptions } from "mongodb";

// Native MongoDB driver — runs on Workers under `nodejs_compat`, the same path
// the sibling mongodb-mcp worker uses in production. See README for the
// native-driver-vs-Data-API decision. Connect only inside a request/queue
// handler (never at module scope); TCP sockets are disallowed at module load.

export const DB = {
  places: "places",
  entity: "entity",
  integrations: "integrations",
} as const;

export const COLLECTION = {
  places: "places",
  placesGeo: "placesGeo",
  entities: "entities",
} as const;

// §7: Bundu Commons custodian entity — owner of natural / owner-less places.
export const BUNDU_COMMONS_ID = "0192e000-c000-7000-8000-000000000001";

export const SCHEMA_VERSION = "v3.2";

export function buildClient(uri: string): MongoClient {
  const options: MongoClientOptions = {
    appName: "fundi/cloudflare-worker",
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 15_000,
  };
  return new MongoClient(uri, options);
}
