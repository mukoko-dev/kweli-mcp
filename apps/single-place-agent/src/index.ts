// single-place-agent worker entrypoint. Owns `POST /tasks`, independent of
// the Kweli MCP: any Nyuchi/Mukoko app can call it directly with its own
// WorkOS M2M client_credentials token (this agent's own dedicated
// client_id/secret pair, stored in the calling app's own secrets). Unlike
// bulk-place-agent, there is no organization restriction here — any
// validly-signed token for this agent's client_id is accepted.
//
// Runs synchronously (no queue): resolve → Overpass check → write, all
// within the request. See agent-do.ts for the resolution logic.

import { getAgentByName } from "agents";
import { m2mConfig, verifyM2M, denyResponse } from "@kweli-mcp/workos-m2m";
import { formatTraceparent, tracerForRequest } from "@kweli-mcp/telemetry";
import { SinglePlaceAgent, type SinglePlaceRequest } from "./agent-do";

export { SinglePlaceAgent };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function requireM2M(request: Request, env: Env): Promise<Response | null> {
  const cfg = m2mConfig(env);
  if (!cfg) return denyResponse(503, "auth not configured");
  const result = await verifyM2M(request, cfg);
  if (!result.ok) return denyResponse(result.status ?? 401, result.error ?? "unauthorized");
  return null;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, worker: "kweli-single-place-agent" });
    }

    if (url.pathname === "/tasks" && request.method === "POST") {
      // Continue the caller's trace (nhimbe → gateway → MCP → here) so a
      // place that never appears can be followed back to the click.
      const tracer = tracerForRequest(request, {
        serviceName: "kweli-single-place-agent",
        env,
        waitUntil: ctx.waitUntil.bind(ctx),
      });

      const denied = await requireM2M(request, env);
      if (denied) {
        tracer.warn("tasks.denied", { status: denied.status });
        return denied;
      }

      const body = (await request.json().catch(() => null)) as SinglePlaceRequest | null;
      if (!body?.name) {
        tracer.warn("tasks.rejected", { reason: "name is required" });
        return json({ error: "name is required" }, 400);
      }

      // One DO per request — there's no natural dedup key for a
      // human-named single place the way SeedTask has region+categories.
      const taskId = crypto.randomUUID();
      const agent = await getAgentByName<Env, SinglePlaceAgent>(env.SINGLE_PLACE_AGENT, taskId);

      const result = await tracer.span(
        "single_place.submit",
        (span) => agent.submit(body, formatTraceparent(span.context)),
        { taskId, name: body.name },
      );

      return json(result, result.status === "done" ? 201 : 422);
    }

    return json({ error: "not found" }, 404);
  },
};
