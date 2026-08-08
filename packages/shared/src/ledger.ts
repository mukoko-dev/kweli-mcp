// The D1 task ledger: the cross-task audit trail (who/what/when requested,
// status, dedup, result summaries). Per-task *execution* state lives in the
// FundiAgent's own embedded store; D1 is the queryable record across all tasks.

import type { CreatedRecord, SeedTask, TaskResult, TaskStatus } from "./types";

export interface LedgerEnv {
  DB: D1Database;
}

export async function insertTask(env: LedgerEnv, task: SeedTask): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tasks (
       task_id, task_type, status, priority, dedup_key,
       source_kind, source_surface, requested_by, query,
       region_json, categories_json, task_json, created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      task.taskId,
      task.taskType,
      task.status,
      task.priority,
      task.dedupKey,
      task.source.kind,
      task.source.surface ?? null,
      task.source.requestedByPersonId ?? null,
      task.source.query ?? null,
      JSON.stringify(task.region),
      JSON.stringify(task.categories),
      JSON.stringify(task),
      task.createdAt,
    )
    .run();
}

export async function findPendingByDedup(env: LedgerEnv, dedupKey: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT task_id FROM tasks WHERE dedup_key = ? AND status IN ('queued','processing') LIMIT 1`,
  )
    .bind(dedupKey)
    .first<{ task_id: string }>();
  return row?.task_id ?? null;
}

export async function markProcessing(env: LedgerEnv, taskId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE tasks SET status='processing', started_at=COALESCE(started_at, ?) WHERE task_id=?`,
  )
    .bind(new Date().toISOString(), taskId)
    .run();
}

export async function markStatus(
  env: LedgerEnv,
  taskId: string,
  status: TaskStatus,
  error?: string,
): Promise<void> {
  await env.DB.prepare(`UPDATE tasks SET status=?, error=? WHERE task_id=?`)
    .bind(status, error ?? null, taskId)
    .run();
}

export async function markResult(
  env: LedgerEnv,
  taskId: string,
  status: TaskStatus,
  result: TaskResult | null,
  error?: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE tasks SET status=?, places_created=?, entities_created=?, skipped=?, notes=?, records=?, error=?, finished_at=? WHERE task_id=?`,
  )
    .bind(
      status,
      result?.placesCreated ?? null,
      result?.entitiesCreated ?? null,
      result?.skipped ?? null,
      result?.notes ?? null,
      result?.records ? JSON.stringify(result.records) : null,
      error ?? null,
      new Date().toISOString(),
      taskId,
    )
    .run();
}

export interface TaskStatusRow {
  taskId: string;
  status: TaskStatus;
  placesCreated: number | null;
  entitiesCreated: number | null;
  skipped: number | null;
  notes: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  records: CreatedRecord[];
}

export async function getTaskStatus(env: LedgerEnv, taskId: string): Promise<TaskStatusRow | null> {
  const row = await env.DB.prepare(
    `SELECT task_id, status, places_created, entities_created, skipped, notes, records, error, created_at, started_at, finished_at
     FROM tasks WHERE task_id=?`,
  )
    .bind(taskId)
    .first<{
      task_id: string;
      status: TaskStatus;
      places_created: number | null;
      entities_created: number | null;
      skipped: number | null;
      notes: string | null;
      records: string | null;
      error: string | null;
      created_at: string;
      started_at: string | null;
      finished_at: string | null;
    }>();
  if (!row) return null;
  return {
    taskId: row.task_id,
    status: row.status,
    placesCreated: row.places_created,
    entitiesCreated: row.entities_created,
    skipped: row.skipped,
    notes: row.notes,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    records: row.records ? (JSON.parse(row.records) as CreatedRecord[]) : [],
  };
}

// Cron sweeper: tasks stuck in failed/partial that the agent's own retries did
// not resolve. Returns the stored task envelopes for re-enqueue.
export async function listRequeuable(env: LedgerEnv, limit = 50): Promise<SeedTask[]> {
  const { results } = await env.DB.prepare(
    `SELECT task_json FROM tasks WHERE status IN ('failed','partial') ORDER BY created_at LIMIT ?`,
  )
    .bind(limit)
    .all<{ task_json: string }>();
  return (results ?? []).map((r) => JSON.parse(r.task_json) as SeedTask);
}
