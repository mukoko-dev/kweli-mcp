// The single enqueue path. The POST /tasks HTTP endpoint and the MCP
// seed_region tool are two faces of this (§5): build → guard → ledger → queue.
// User-initiated work outranks bulk ops in priority (§2).

import { BoundaryGuardError, boundaryBbox, guardRegion } from "@kweli-mcp/shared";
import { expandBulkIntent } from "@kweli-mcp/shared";
import { findPendingByDedup, insertTask, type LedgerEnv } from "@kweli-mcp/shared";
import { type BulkIntent, type Region, type SeedTask, type SeedTaskInput } from "@kweli-mcp/shared";
import { uuidv7 } from "@kweli-mcp/shared";

export interface EnqueueEnv extends LedgerEnv {
  TASK_QUEUE: Queue<SeedTask>;
  MONGODB_URI: string;
  FUNDI_BOUNDARY_BBOX?: string;
  FUNDI_ALLOW_FALLBACK_CAPITALS?: string;
}

function dedupKeyFor(region: Region, categories: string[] | "all"): string {
  const cats = categories === "all" ? "all" : [...categories].sort().join(",");
  return `${JSON.stringify(region)}|${cats}`;
}

function defaultPriority(source: SeedTaskInput["source"], explicit?: number): number {
  if (explicit !== undefined) return explicit;
  // search-miss / app empty-state are user-facing → higher than bulk ops.
  return source.kind === "ops_mcp" ? 1 : 10;
}

export interface SubmitOutcome {
  taskId: string;
  deduped: boolean;
}

export async function submitSeedTask(
  env: EnqueueEnv,
  input: SeedTaskInput,
): Promise<SubmitOutcome> {
  // Africa boundary guard on acceptance (admin regions are deferred to the agent
  // once their centroid resolves).
  const guard = guardRegion(input.region, boundaryBbox(env));
  if (!guard.ok) throw new BoundaryGuardError(guard.reason ?? "outside boundary");

  const dedupKey = dedupKeyFor(input.region, input.categories);
  const existing = await findPendingByDedup(env, dedupKey);
  if (existing) return { taskId: existing, deduped: true };

  const task: SeedTask = {
    taskId: uuidv7(),
    taskType: "seed_region",
    region: input.region,
    categories: input.categories,
    source: input.source,
    status: "queued",
    priority: defaultPriority(input.source, input.priority),
    dedupKey,
    createdAt: new Date().toISOString(),
  };

  await insertTask(env, task);
  await env.TASK_QUEUE.send(task);
  return { taskId: task.taskId, deduped: false };
}

export async function submitBulkIntent(
  env: EnqueueEnv,
  intent: BulkIntent,
): Promise<SubmitOutcome[]> {
  const inputs = await expandBulkIntent(env, intent);
  const outcomes: SubmitOutcome[] = [];
  for (const input of inputs) {
    outcomes.push(await submitSeedTask(env, input));
  }
  return outcomes;
}
