// Hand-maintained ambient Env — regenerate reference bindings from
// wrangler.jsonc with `wrangler types` once this app is first deployed (that
// command needs a live Cloudflare account/session this sandbox doesn't have).
// Keep this in sync with wrangler.jsonc's bindings by hand until then.

import type { FundiMcp } from "./mcp";
import type { SeedTask } from "@kweli-mcp/shared";
import type OAuthProvider from "@cloudflare/workers-oauth-provider";

export {};

declare global {
  interface Env {
    MCP_OBJECT: DurableObjectNamespace<FundiMcp>;
    TASK_QUEUE: Queue<SeedTask>;
    DB: D1Database;
    OAUTH_KV: KVNamespace;
    // Injected by @cloudflare/workers-oauth-provider at fetch time — not a
    // wrangler binding.
    OAUTH_PROVIDER: OAuthProvider;

    MONGODB_URI: string;
    COOKIE_ENCRYPTION_KEY: string;
    WORKOS_AUTHKIT_DOMAIN: string;
    WORKOS_CLIENT_ID: string;
    WORKOS_ORGANIZATION_ID?: string;
    WORKOS_ALLOWED_ORG_IDS?: string;
    WORKOS_REQUIRED_PERMISSION?: string;
    WORKOS_M2M_CLIENT_ID?: string;
    WORKOS_AGENTS_M2M_CLIENT_ID?: string;
    FUNDI_API_TOKEN?: string;

    // The literal cross-worker binding: apps/bulk-ingestion-agent's fetch
    // handler, reachable only from within Cloudflare's network.
    BULK_AGENT: Fetcher;
    INTERNAL_FORCE_RUN_TOKEN?: string;
  }
}
