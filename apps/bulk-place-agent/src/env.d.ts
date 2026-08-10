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

    // WorkOS M2M — this agent's own dedicated application. Callers (the
    // Kweli MCP, or any other Nyuchi/Mukoko app) authenticate as this
    // client_id via client_credentials; WORKOS_ALLOWED_ORG_IDS restricts
    // bulk seeding to members of the Nyuchi org (unlike single-place-agent,
    // which has no org restriction).
    /** Preferred name (see the estate-wide standard). */
    WORKOS_ISSUER?: string;
    /** Legacy alias for WORKOS_ISSUER; still honoured. */
    WORKOS_AUTHKIT_DOMAIN: string;
    WORKOS_M2M_CLIENT_ID: string;
    WORKOS_ALLOWED_ORG_IDS?: string;

    // Telemetry (optional). The D1 `DB` binding above doubles as the
    // `agent_events` sink; OTLP export activates when an endpoint is set.
    OTLP_ENDPOINT?: string;
    OTLP_HEADERS?: string;
    TELEMETRY_D1_DISABLED?: string;
  }
}
