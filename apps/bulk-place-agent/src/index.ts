// bulk-place-agent worker entrypoint — the bulk place generator, independent
// of the Kweli MCP: any Nyuchi/Mukoko app can call POST /tasks directly with
// its own WorkOS M2M client_credentials token (client_id/secret stored in
// that app's own secrets), the same way the Kweli MCP itself does.
//
//   • POST /tasks — public, WorkOS M2M gated (client_credentials), org
//     ID-restricted (WORKOS_ALLOWED_ORG_IDS) — only members of the Nyuchi
//     org can trigger a bulk seed. Accepts either a single seed_region input
//     or a bulk intent (fans out into many region tasks).
//   • queue     — the consumer: routes each task to a durable FundiAgent (RPC).
//   • scheduled — a sweeper that re-enqueues tasks the agent's retries missed.
//   • fetch     — also serves /health and /internal/force-run (used by the
//     Kweli MCP over a service binding to nudge a stuck task immediately).
//
// FundiAgent is a Cloudflare Agent (a SQLite-backed Durable Object) — see
// agent-do.ts. This worker is BOTH producer and consumer on the
// `fundi-ingestion-tasks` queue (unlike before the split, nothing else needs
// producer access now that /tasks lives here) and owns the
// `fundi-ingestion-ledger` D1 database.

import { getAgentByName } from "agents";
import { z } from "zod";
import { FundiAgent } from "./agent-do";
import { submitBulkIntent, submitSeedTask } from "./enqueue";
import { m2mConfig, verifyM2M, denyResponse } from "@kweli-mcp/workos-m2m";
import { tracerForJob, tracerForRequest, type Tracer } from "@kweli-mcp/telemetry";
import {
  listRequeuable,
  markStatus,
  bulkIntentSchema,
  seedTaskInputSchema,
  BoundaryGuardError,
  type SeedTask,
} from "@kweli-mcp/shared";

export { FundiAgent };

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

async function handleSubmit(request: Request, env: Env, tracer: Tracer): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  try {
    if (body && typeof body === "object" && "intent" in body) {
      const intent = bulkIntentSchema.parse(body);
      const outcomes = await submitBulkIntent(env, intent, tracer.context.traceId);
      return json({
        kind: "bulk",
        tasksCreated: outcomes.filter((o) => !o.deduped).length,
        deduped: outcomes.filter((o) => o.deduped).length,
        taskIds: outcomes.map((o) => o.taskId),
      });
    }
    const input = seedTaskInputSchema.parse(body);
    const outcome = await submitSeedTask(env, input, tracer.context.traceId);
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
    tracer.error("submit.failed", e);
    return json({ error: "could not process task" }, 500);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const tracer = tracerForRequest(request, {
      serviceName: "kweli-bulk-place-agent",
      env,
      waitUntil: ctx.waitUntil.bind(ctx),
    });

    if (url.pathname === "/health") {
      return json({ ok: true, worker: "kweli-bulk-place-agent" });
    }

    if (url.pathname === "/tasks" && request.method === "POST") {
      const denied = await requireM2M(request, env);
      if (denied) {
        tracer.warn("tasks.denied", { status: denied.status });
        return denied;
      }
      return handleSubmit(request, env, tracer);
    }

    // Used by the Kweli MCP over a service binding to nudge a stuck task's
    // DO to retry immediately, instead of waiting for the hourly cron sweep.
    // Also M2M-gated — a service binding doesn't imply trust by itself.
    if (url.pathname === "/internal/force-run" && request.method === "POST") {
      const denied = await requireM2M(request, env);
      if (denied) {
        tracer.warn("force_run.denied", { status: denied.status });
        return denied;
      }
      const body = (await request.json().catch(() => null)) as { taskId?: string } | null;
      if (!body?.taskId) return json({ error: "taskId is required" }, 400);
      try {
        const agent = await getAgentByName<Env, FundiAgent>(env.FUNDI_AGENT, body.taskId);
        const status = await agent.forceRun();
        return json({ taskId: body.taskId, status });
      } catch (e) {
        // Detail stays server-side: this response is caller-facing and a raw
        // exception leaks internals (CodeQL: stack-trace exposure).
        tracer.error("force_run.failed", e, { taskId: body.taskId });
        return json({ error: "could not force-run task" }, 500);
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
        // Resume the enqueuing request's trace so a consume failure is
        // attributable to the click that caused it, not just to the queue.
        tracerForJob({
          serviceName: "kweli-bulk-place-agent",
          instanceId: task.taskId,
          env,
          traceId: task.traceId ?? null,
        }).error("queue.consume_failed", e, { taskId: task.taskId });
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
        tracerForJob({
          serviceName: "kweli-bulk-place-agent",
          env,
          waitUntil: ctx.waitUntil.bind(ctx),
        }).info("sweep.done", { requeued: tasks.length });
      })(),
    );
  },
};
