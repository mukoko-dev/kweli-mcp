import { z } from "zod";

// ---------------------------------------------------------------------------
// The task model (§2 of the build brief). A task is an atomic unit of
// ingestion work. Every source — search-miss, app empty-state, ops MCP — emits
// this same shape and hits the same queue.
// ---------------------------------------------------------------------------

export const regionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("point_radius"),
    center: z.tuple([z.number(), z.number()]).describe("[lng, lat]"),
    radiusMeters: z.number().positive().max(50_000),
  }),
  z.object({
    kind: z.literal("bbox"),
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).describe("[s, w, n, e]"),
  }),
  z.object({
    kind: z.literal("admin"),
    adminPlaceId: z.string().min(1),
  }),
]);

export type Region = z.infer<typeof regionSchema>;

export const categoriesSchema = z
  .union([z.array(z.string()).min(1), z.literal("all")])
  .describe('OSM-derived place categories, or "all" for the full taxonomy.');

export const sourceSchema = z.object({
  kind: z.enum(["search_miss", "app_empty_state", "ops_mcp"]),
  surface: z.string().optional(),
  requestedByPersonId: z.string().optional(),
  query: z.string().optional(),
});

export type TaskSource = z.infer<typeof sourceSchema>;

export type TaskStatus = "queued" | "processing" | "done" | "failed" | "partial";

// One record Fundi wrote for a task. The ids are logged so "what this task
// built" is deterministic — not a fragile global "most recent" query.
export interface CreatedRecord {
  placeId: string;
  entityId: string | null; // null for natural / Bundu-Commons-owned places
  osmId: string;
  name: string;
  placeCreated: boolean;
  entityCreated: boolean;
}

export interface TaskResult {
  placesCreated: number;
  entitiesCreated: number;
  skipped: number;
  notes?: string;
  records?: CreatedRecord[];
}

export interface SeedTask {
  taskId: string;
  taskType: "seed_region";
  region: Region;
  categories: string[] | "all";
  source: TaskSource;
  status: TaskStatus;
  priority: number;
  dedupKey: string;
  createdAt: string;
  /**
   * W3C trace id of the request that enqueued this task.
   *
   * Queue work runs long after the caller's response, so the trace has to be
   * carried on the task envelope itself — there is no header to propagate
   * through a queue. Without it, ingestion appears in the logs as an orphan
   * with no visible cause.
   */
  traceId?: string;
  startedAt?: string;
  finishedAt?: string;
  result?: TaskResult;
}

// Accepted on the wire (POST /tasks and the MCP seed_region tool). The server
// fills taskId/status/dedupKey/createdAt.
export const seedTaskInputSchema = z.object({
  region: regionSchema,
  categories: categoriesSchema.default("all"),
  source: sourceSchema,
  priority: z.number().int().optional(),
});

export type SeedTaskInput = z.infer<typeof seedTaskInputSchema>;

// A bulk intent fans out (via a generator) into many atomic tasks.
// `country_settlements` fans a whole country into one point_radius task per
// settlement (city/town/village in places.placesGeo) — the sanctioned way to
// seed at country scale, since a single admin task would blow the tile budget.
export const bulkIntentSchema = z.object({
  intent: z.enum(["african_capitals", "country_settlements"]),
  radiusMeters: z.number().positive().max(50_000).default(20_000),
  categories: categoriesSchema.default("all"),
  source: sourceSchema.default({ kind: "ops_mcp" }),
  limit: z.number().int().positive().max(500).optional(),
  // country_settlements only: the places.placesGeo country doc id, or its
  // ISO 3166-1 alpha-2 code. Exactly one is required for that intent.
  countryPlaceId: z.string().min(1).optional(),
  countryIso: z.string().length(2).optional(),
});

export type BulkIntent = z.infer<typeof bulkIntentSchema>;
