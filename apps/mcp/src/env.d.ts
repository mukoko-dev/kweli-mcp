// Hand-maintained ambient Env — regenerate reference bindings from
// wrangler.jsonc with `wrangler types` once this app is first deployed (that
// command needs a live Cloudflare account/session this sandbox doesn't have).
// Keep this in sync with wrangler.jsonc's bindings by hand until then.

import type { KweliMcp } from "./mcp";
import type OAuthProvider from "@cloudflare/workers-oauth-provider";

export {};

declare global {
  interface Env {
    MCP_OBJECT: DurableObjectNamespace<KweliMcp>;
    DB: D1Database;
    OAUTH_KV: KVNamespace;
    // Injected by @cloudflare/workers-oauth-provider at fetch time — not a
    // wrangler binding.
    OAUTH_PROVIDER: OAuthProvider;

    MONGODB_URI: string;
    COOKIE_ENCRYPTION_KEY: string;

    // Interactive OAuth (Authorization Code + PKCE) — browser/MCP-client login.
    /** Preferred name (see the estate-wide standard). */
    WORKOS_ISSUER?: string;
    /** Legacy alias for WORKOS_ISSUER; still honoured. */
    WORKOS_AUTHKIT_DOMAIN: string;
    WORKOS_CLIENT_ID: string;
    WORKOS_ORGANIZATION_ID?: string;
    WORKOS_ALLOWED_ORG_IDS?: string;
    WORKOS_REQUIRED_PERMISSION?: string;

    // Outbound M2M — the Kweli MCP's OWN credentials for calling each
    // independent agent, distinct per agent (never shared with the
    // interactive OAuth app above, and never shared between the two agents).
    BULK_PLACE_AGENT: Fetcher;
    BULK_M2M_CLIENT_ID: string;
    BULK_M2M_CLIENT_SECRET: string;

    SINGLE_PLACE_AGENT: Fetcher;
    SINGLE_M2M_CLIENT_ID: string;
    SINGLE_M2M_CLIENT_SECRET: string;

    // Telemetry (optional). The D1 `DB` binding above doubles as the
    // `agent_events` sink; OTLP export activates when an endpoint is set.
    OTLP_ENDPOINT?: string;
    OTLP_HEADERS?: string;
    TELEMETRY_D1_DISABLED?: string;
  }
}
