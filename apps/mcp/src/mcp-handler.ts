/**
 * The MCP endpoint: the official SDK v2 `createMcpHandler` serving stateless
 * Streamable HTTP, with a fresh `McpServer` (server.ts) per request. It
 * answers 2026-07-28 clients and, through the SDK's stateless legacy path,
 * 2025-era clients; protocol-version checks, batches, notifications and
 * GET/DELETE (405) are the SDK's.
 *
 * Mounted twice by index.ts: as the OAuth provider's `apiHandler` (signed-in
 * requests, after the provider has verified the token) and directly for
 * anonymous requests that public-gate.ts has let through.
 *
 * Around the SDK handler it adds what the SDK leaves to the host:
 *   - Origin validation (a MUST of the Streamable HTTP transport);
 *   - the legacy tool-name aliases (public-gate.ts), on both doors;
 *   - one Mongo client per request, closed when the request ends. Workers
 *     tie a socket to the request that opened it, so a client cached across
 *     requests hangs (see mukoko-news-gateway's MongoService history).
 */

import {
  createMcpHandler,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import type { MongoClient } from "mongodb";
import { buildClient } from "@kweli-mcp/mongo";
import { buildSink, Tracer } from "@kweli-mcp/telemetry";
import { rewriteLegacyToolNames } from "./public-gate";
import { ConfigError, createKweliServer, type KweliDeps } from "./server";

/** Browser Origins allowed besides the request's own host. */
function allowedOrigins(env: Env, requestHost: string): string[] {
  const extra = (env.MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return [
    requestHost,
    "kweli.mukoko.com",
    "localhost",
    "127.0.0.1",
    "[::1]",
    ...extra,
  ];
}

export interface HandlerOverrides {
  /** Tests inject a fake Mongo client here. */
  mongo?: (env: Env) => Promise<MongoClient>;
}

export function createKweliMcpHandler(overrides: HandlerOverrides = {}) {
  return {
    async fetch(
      request: Request,
      env: Env,
      ctx: ExecutionContext,
    ): Promise<Response> {
      const rejected = originValidationResponse(
        request,
        allowedOrigins(env, new URL(request.url).hostname),
      );
      if (rejected) return rejected;

      let forward = request;
      if (request.method === "POST") {
        const raw = await request.text();
        forward = new Request(request, {
          body: rewriteLegacyToolNames(raw) ?? raw,
        });
      }

      let client: MongoClient | undefined;
      const deps: KweliDeps = {
        env,
        tracer: new Tracer({
          serviceName: "kweli-mcp",
          instanceId: crypto.randomUUID(),
          sink: buildSink({
            env,
            waitUntil: (p: Promise<unknown>) => ctx.waitUntil(p),
          }),
        }),
        async mongo() {
          if (client) return client;
          if (overrides.mongo) {
            client = await overrides.mongo(env);
            return client;
          }
          if (!env.MONGODB_URI) {
            throw new ConfigError(
              "The Kweli graph is not connected on this deployment yet, so this read cannot run. Try again later, or use https://kweli.mukoko.com.",
            );
          }
          const c = buildClient(env.MONGODB_URI);
          await c.connect();
          client = c;
          return c;
        },
      };

      const handler = createMcpHandler(() => createKweliServer(deps), {
        responseMode: "json",
        onerror: (error) =>
          console.error("[kweli-mcp] handler error:", error.message),
      });
      try {
        const res = await handler.fetch(forward);
        // A 2025-era answer is an SSE stream the tool may still be writing
        // when fetch resolves. Read it to the end before the Mongo client is
        // closed; every answer here is bounded by CHARACTER_LIMIT, so
        // buffering is cheap.
        const body = res.body ? await res.arrayBuffer() : null;
        return new Response(body, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
      } finally {
        if (client && !overrides.mongo)
          ctx.waitUntil(client.close().catch(() => undefined));
      }
    },
  };
}

export const kweliMcpHandler = createKweliMcpHandler();
