// mcp-places worker entrypoint — Mukoko Kweli's public, read-only graph MCP
// (plus the write `request_place` tool), Streamable HTTP / JSON-RPC 2.0 over
// POST /mcp. No auth, per Mukoko's open-data policy — rate-limited per IP via
// Cloudflare's native Rate Limiting binding instead. Ported from
// `nyuchi/kweli`'s `app/mcp/route.ts` + `lib/mcp/server.ts`.
//
// `request_place` is the one tool that writes: it forwards to
// apps/single-place-agent over the SINGLE_PLACE_AGENT service binding — the
// second literal cross-worker binding in this monorepo (alongside
// mcp-ingestion → bulk-ingestion-agent).

import { handleMcpBody, rpcError } from "./server";
import type { KweliEnv } from "./tools";

interface Env extends KweliEnv {
  MCP_RATE_LIMITER: { limit(opts: { key: string }): Promise<{ success: boolean }> };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/mcp") {
      return json({ error: "not found" }, 404);
    }

    if (request.method === "GET") {
      return new Response(JSON.stringify({ error: "POST JSON-RPC 2.0 messages to this endpoint" }), {
        status: 405,
        headers: { "content-type": "application/json", Allow: "POST" },
      });
    }
    if (request.method !== "POST") {
      return json({ error: "method not allowed" }, 405);
    }

    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const { success } = await env.MCP_RATE_LIMITER.limit({ key: `mcp-places:${ip}` });
    if (!success) {
      return json({ error: "rate limit exceeded" }, 429);
    }

    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      return json(rpcError(null, -32700, "Parse error"), 400);
    }

    const body = await handleMcpBody(parsed, env);
    if (body === null) return new Response(null, { status: 202 });
    return json(body);
  },
};
