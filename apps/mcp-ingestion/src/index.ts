// mcp-ingestion worker entrypoint.
//   • /mcp     — OAuth-gated (WorkOS Authorization Code + PKCE) MCP surface
//                (FundiMcp — seed_region, seed_admin_bulk, task_status,
//                task_records, list_recent_places, compute_pluscode,
//                overpass_lookup, resolve_hierarchy, list_geo_areas).
//   • /tasks   — M2M-gated (WorkOS client_credentials) submit surface, so
//                agents (fundi-ingestion's own callers, kweli's admin sync,
//                nhimbe's search-miss reporter) can enqueue work directly.
//
// FundiMcp is a Cloudflare Agent (a Durable Object) — see mcp.ts. This worker
// is a producer on the shared `fundi-ingestion-tasks` queue and a reader of
// the shared `fundi-ingestion-ledger` D1 database; the sibling
// apps/bulk-ingestion-agent worker is the sole queue consumer and the writer
// of that ledger (FundiAgent). The `BULK_AGENT` service binding below is the
// one place this worker calls that one directly — literal cross-worker
// binding, not just shared resources.

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import { BoundaryGuardError } from "@kweli-mcp/shared";
import { FundiAuthkitHandler } from "./authkit-handler";
import { submitBulkIntent, submitSeedTask } from "./enqueue";
import { denyResponse, m2mConfig, verifyM2M } from "./m2m-auth";
import { bulkIntentSchema, seedTaskInputSchema } from "@kweli-mcp/shared";
import { FundiMcp } from "./mcp";

export { FundiMcp };

async function requireTaskAuth(request: Request, env: Env): Promise<Response | null> {
  const header = request.headers.get("authorization") ?? "";
  if (env.FUNDI_API_TOKEN && header === `Bearer ${env.FUNDI_API_TOKEN}`) return null;
  const audience = env.WORKOS_AGENTS_M2M_CLIENT_ID || env.WORKOS_M2M_CLIENT_ID;
  const cfg = m2mConfig(env, audience);
  if (!cfg) return denyResponse(503, "auth not configured");
  const result = await verifyM2M(request, cfg);
  if (!result.ok) return denyResponse(result.status ?? 401, result.error ?? "unauthorized");
  return null;
}

async function handleSubmit(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  try {
    if (body && typeof body === "object" && "intent" in body) {
      const intent = bulkIntentSchema.parse(body);
      const outcomes = await submitBulkIntent(env, intent);
      return json({
        kind: "bulk",
        tasksCreated: outcomes.filter((o) => !o.deduped).length,
        deduped: outcomes.filter((o) => o.deduped).length,
        taskIds: outcomes.map((o) => o.taskId),
      });
    }
    const input = seedTaskInputSchema.parse(body);
    const outcome = await submitSeedTask(env, input);
    return json(
      { kind: "seed", ...outcome, message: "This region will exist going forward." },
      202,
    );
  } catch (e) {
    if (e instanceof z.ZodError) {
      return json({ error: "invalid request body", issues: e.issues }, 400);
    }
    if (e instanceof BoundaryGuardError) {
      return json({ error: "region is outside the ingestion boundary" }, 422);
    }
    console.error("submit failed", { error: e instanceof Error ? e.message : String(e) });
    return json({ error: "could not process task" }, 500);
  }
}

// Nudges a stuck task's agent to retry immediately, over the BULK_AGENT
// service binding — real Worker-to-Worker RPC, never leaving Cloudflare's
// network. Used by ops/support instead of waiting for the hourly cron sweep.
async function handleForceRun(request: Request, env: Env): Promise<Response> {
  let body: { taskId?: string } | null;
  try {
    body = (await request.json()) as { taskId?: string };
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!body?.taskId) return json({ error: "taskId is required" }, 400);

  const resp = await env.BULK_AGENT.fetch("https://internal/internal/force-run", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(env.INTERNAL_FORCE_RUN_TOKEN ? { "x-internal-token": env.INTERNAL_FORCE_RUN_TOKEN } : {}),
    },
    body: JSON.stringify({ taskId: body.taskId }),
  });
  return new Response(await resp.text(), {
    status: resp.status,
    headers: { "content-type": "application/json" },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// /mcp is gated by WorkOS OAuth (Authorization Code + PKCE). MCP clients
// (Claude.ai web, Cursor, Codex, mcp-remote, etc.) sign in via WorkOS.
const oauthProvider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: FundiMcp.serve("/mcp") as never,
  defaultHandler: FundiAuthkitHandler as never,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // /tasks remains M2M-gated so agents can call it without browser sign-in.
    if (url.pathname === "/tasks" && request.method === "POST") {
      const denied = await requireTaskAuth(request, env);
      if (denied) return denied;
      return handleSubmit(request, env);
    }

    if (url.pathname === "/internal/force-run/proxy" && request.method === "POST") {
      const denied = await requireTaskAuth(request, env);
      if (denied) return denied;
      return handleForceRun(request, env);
    }

    // Everything else (/mcp, /authorize, /token, /register, /, /health, /callback)
    // flows through the OAuth provider.
    return oauthProvider.fetch(request, env, ctx);
  },
};
