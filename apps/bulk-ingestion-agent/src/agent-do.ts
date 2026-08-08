// FundiAgent — the durable, stateful executor, built on the Cloudflare Agents
// SDK (a Durable Object). One instance per task (keyed by taskId). It owns the
// task's execution state and uses the SDK's `this.schedule()` for durable
// retry/backoff, rather than a hand-rolled cron loop. The queue consumer routes
// each task here via RPC (`run`). The skill loop itself lives in agent.ts.

import { Agent } from "agents";
import type { MongoClient } from "mongodb";
import { buildDeps, runTask } from "./agent";
import { markProcessing, markResult, markStatus } from "@kweli-mcp/shared";
import { buildClient } from "@kweli-mcp/mongo";
import type { SeedTask, TaskResult, TaskStatus } from "@kweli-mcp/shared";

const MAX_ATTEMPTS = 4;

function backoffSeconds(attempt: number): number {
  return Math.min(2 ** attempt * 5, 600); // 10s, 20s, 40s… capped at 10m
}

export interface FundiState {
  task: SeedTask | null;
  status: TaskStatus;
  attempts: number;
  result?: TaskResult;
  error?: string;
}

export class FundiAgent extends Agent<Env, FundiState> {
  initialState: FundiState = { task: null, status: "queued", attempts: 0 };

  // Cached across runs on this DO instance to avoid reconnecting on every retry.
  private mongo?: MongoClient;

  private async getMongo(): Promise<MongoClient> {
    if (this.mongo) return this.mongo;
    const uri = this.env.MONGODB_URI;
    if (!uri) throw new Error("MONGODB_URI is not configured on the worker");
    const client = buildClient(uri);
    await client.connect();
    this.mongo = client;
    return client;
  }

  // RPC entry point invoked by the queue consumer.
  async run(task: SeedTask): Promise<void> {
    this.setState({ task, status: "queued", attempts: 0 });
    await this.execute();
  }

  // Scheduled retry callback (invoked by this.schedule). Named to avoid the
  // Agent base class's reserved `retry()` helper.
  async retryTask(): Promise<void> {
    await this.execute();
  }

  // RPC entry point for the worker's /internal/force-run endpoint (called by
  // apps/mcp-ingestion over the BULK_AGENT service binding). Only meaningful
  // once this DO instance has already seen its task via `run()` — a taskId
  // the queue never delivered here has no state to re-execute, since Fundi
  // doesn't persist SeedTask envelopes outside D1 + the owning DO.
  async forceRun(): Promise<TaskStatus | "unknown"> {
    if (!this.state.task) return "unknown";
    await this.execute();
    return this.state.status;
  }

  private async execute(): Promise<void> {
    const task = this.state.task;
    if (!task) return;

    this.setState({ ...this.state, status: "processing" });
    await markProcessing(this.env, task.taskId);

    try {
      const client = await this.getMongo();
      const deps = await buildDeps(client, this.env);
      const result = await runTask(task, deps);
      this.setState({ ...this.state, status: "done", result });
      await markResult(this.env, task.taskId, "done", result);
    } catch (e) {
      const error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      const attempts = this.state.attempts + 1;

      if (attempts < MAX_ATTEMPTS) {
        this.setState({ ...this.state, status: "queued", attempts, error });
        await markStatus(this.env, task.taskId, "queued", error);
        await this.schedule(backoffSeconds(attempts), "retryTask");
      } else {
        this.setState({ ...this.state, status: "failed", attempts, error });
        await markResult(this.env, task.taskId, "failed", null, error);
      }
    }
  }
}
