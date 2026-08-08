// Bulk-ingestion-agent worker entrypoint.
//   • queue     — the consumer: routes each task to a durable FundiAgent (RPC).
//   • scheduled — a sweeper that re-enqueues tasks the agent's retries missed.
//   • fetch     — a small internal-only surface: /health, and /internal/force-run
//                 (POST {taskId}), which apps/mcp-ingestion calls over its
//                 `BULK_AGENT` service binding to nudge a stuck task immediately
//                 instead of waiting for the hourly cron sweep.
//
// FundiAgent is a Cloudflare Agent (a SQLite-backed Durable Object) — see
// agent-do.ts. The MCP-facing surface (FundiMcp, /tasks submit) lives in the
// sibling apps/mcp-ingestion worker; the two share the `fundi-ingestion-tasks`
// queue (this worker is the sole consumer) and the fundi-ingestion-ledger D1
// database (this worker writes it; mcp-ingestion reads it for task_status).

import { getAgentByName } from "agents";
import { FundiAgent } from "./agent-do";
import { listRequeuable, markStatus, type SeedTask } from "@kweli-mcp/shared";

export { FundiAgent };

// See env.d.ts for the Env shape (FUNDI_AGENT, TASK_QUEUE, DB, etc.). The
// shared-secret INTERNAL_FORCE_RUN_TOKEN is defense-in-depth on top of the
// BULK_AGENT service binding itself never leaving Cloudflare's network.

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
      return json({ ok: true, worker: "kweli-bulk-ingestion-agent" });
    }

    // Called only via the BULK_AGENT service binding from apps/mcp-ingestion
    // (a service binding's fetch never leaves Cloudflare's network — this is
    // the literal "workers bound together for cross-functional requests"
    // wiring). The token is defense-in-depth, not the sole gate.
    if (url.pathname === "/internal/force-run" && request.method === "POST") {
      if (
        env.INTERNAL_FORCE_RUN_TOKEN &&
        request.headers.get("x-internal-token") !== env.INTERNAL_FORCE_RUN_TOKEN
      ) {
        return json({ error: "unauthorized" }, 401);
      }
      const body = (await request.json().catch(() => null)) as { taskId?: string } | null;
      if (!body?.taskId) return json({ error: "taskId is required" }, 400);
      try {
        const agent = await getAgentByName<Env, FundiAgent>(env.FUNDI_AGENT, body.taskId);
        // The agent's own ledger-backed state is the source of truth for
        // what to re-run; `run` is idempotent per SeedTask (dedup by taskId).
        const status = await agent.forceRun();
        return json({ taskId: body.taskId, status });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    return json({ error: "not found" }, 404);
  },

  // Queue consumer: hand each task to its durable agent.
  async queue(batch: MessageBatch<SeedTask>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const task = message.body;
      try {
        const agent = await getAgentByName<Env, FundiAgent>(env.FUNDI_AGENT, task.taskId);
        await agent.run(task);
        message.ack();
      } catch (e) {
        console.error("queue.consume failed", { taskId: task.taskId, error: String(e) });
        message.retry();
      }
    }
  },

  // Cron sweeper: re-enqueue tasks the agent's retries missed.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const tasks = await listRequeuable(env, 50);
        for (const task of tasks) {
          await markStatus(env, task.taskId, "queued");
          await env.TASK_QUEUE.send(task);
        }
        console.log(
          JSON.stringify({ worker: "kweli-bulk-ingestion-agent", event: "sweep.done", requeued: tasks.length }),
        );
      })(),
    );
  },
};
