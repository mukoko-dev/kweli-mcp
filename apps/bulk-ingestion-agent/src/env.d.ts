// Hand-maintained ambient Env — regenerate reference bindings from
// wrangler.jsonc with `wrangler types` once this app is first deployed (that
// command needs a live Cloudflare account/session this sandbox doesn't have).
// Keep this in sync with wrangler.jsonc's bindings by hand until then.

import type { FundiAgent } from "./agent-do";
import type { SeedTask } from "@kweli-mcp/shared";

export {};

declare global {
  interface Env {
    FUNDI_AGENT: DurableObjectNamespace<FundiAgent>;
    TASK_QUEUE: Queue<SeedTask>;
    DB: D1Database;
    DEDUP_KV: KVNamespace;
    AI: Ai;
    MONGODB_URI: string;
    FUNDI_AI_MODEL?: string;
    FUNDI_AI_GATEWAY?: string;
    FUNDI_BOUNDARY_BBOX?: string;
    WHAT3WORDS_API_KEY?: string;
    INTERNAL_FORCE_RUN_TOKEN?: string;
  }
}
