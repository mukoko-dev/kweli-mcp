-- Fundi task ledger (D1). The cross-task audit trail: who/what/when requested,
-- status, dedup, and result summaries. Per-task execution state lives in the
-- FundiAgent's own embedded store; this is the queryable record across tasks.

CREATE TABLE IF NOT EXISTS tasks (
  task_id          TEXT PRIMARY KEY,
  task_type        TEXT NOT NULL,
  status           TEXT NOT NULL,            -- queued | processing | done | failed | partial
  priority         INTEGER NOT NULL DEFAULT 0,
  dedup_key        TEXT,
  source_kind      TEXT,                     -- search_miss | app_empty_state | ops_mcp
  source_surface   TEXT,
  requested_by     TEXT,
  query            TEXT,
  region_json      TEXT NOT NULL,
  categories_json  TEXT NOT NULL,
  task_json        TEXT NOT NULL,            -- full SeedTask envelope, for re-enqueue
  places_created   INTEGER,
  entities_created INTEGER,
  skipped          INTEGER,
  notes            TEXT,
  error            TEXT,
  created_at       TEXT NOT NULL,
  started_at       TEXT,
  finished_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks (created_at);

-- Identical *pending* tasks collapse: a dedup_key is unique only while queued or
-- processing. Once a task finishes it leaves this partial index, so the same
-- region can be re-seeded later.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_dedup_pending
  ON tasks (dedup_key)
  WHERE dedup_key IS NOT NULL AND status IN ('queued', 'processing');
