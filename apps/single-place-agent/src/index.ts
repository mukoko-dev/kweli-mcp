// single-place-agent worker entrypoint — STUB (see agent-do.ts for what's
// missing). Owns `POST /tasks`, the endpoint apps/mcp-places' `request_place`
// tool calls over the SINGLE_PLACE_AGENT service binding.

import { getAgentByName } from "agents";
import { SinglePlaceAgent, type SinglePlaceRequest } from "./agent-do";

export { SinglePlaceAgent };

interface Env {
  SINGLE_PLACE_AGENT: DurableObjectNamespace<SinglePlaceAgent>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, worker: "kweli-single-place-agent", status: "stub" });
    }

    if (url.pathname === "/tasks" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as SinglePlaceRequest | null;
      if (!body?.name) return json({ error: "name is required" }, 400);

      // One DO per request — there's no natural dedup key for a
      // human-named single place the way SeedTask has region+categories.
      const agent = await getAgentByName<Env, SinglePlaceAgent>(
        env.SINGLE_PLACE_AGENT,
        crypto.randomUUID(),
      );
      const result = await agent.submit(body);
      return json(result, 202);
    }

    return json({ error: "not found" }, 404);
  },
};
