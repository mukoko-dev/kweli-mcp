-- Durable per-agent event log — the queryable telemetry table.
--
-- ONE table, not one per agent. `service_name` gives the per-agent view with
-- a WHERE clause, while `trace_id` still lets a single user action be
-- reconstructed across every service it touched. Table-per-agent would
-- optimise the easy query ("show me this agent") and turn the hard one
-- ("why did this one request fail?") into a UNION that grows with every new
-- agent. D1 also serialises writes per *database*, not per table, so
-- splitting buys no write throughput either.
--
-- Shaped to map onto OpenTelemetry without translation:
--   service_name  → Resource `service.name`
--   instance_id   → Resource `service.instance.id`  (the DO name; for
--                    bulk-place-agent that IS the task_id, so this joins
--                    straight to the `tasks` ledger below)
--   trace/span/parent → Span identity
--   severity      → LogRecord SeverityText

CREATE TABLE IF NOT EXISTS agent_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp        TEXT NOT NULL,           -- ISO 8601, UTC
  trace_id         TEXT NOT NULL,           -- W3C, 32 hex
  span_id          TEXT NOT NULL,           -- W3C, 16 hex
  parent_span_id   TEXT,
  service_name     TEXT NOT NULL,           -- the agent id
  instance_id      TEXT,                    -- Durable Object name / task id
  severity         TEXT NOT NULL,           -- debug | info | warn | error
  name             TEXT NOT NULL,           -- span name or log message
  duration_ms      INTEGER,                 -- spans only
  status           TEXT,                    -- ok | error, spans only
  attributes_json  TEXT NOT NULL DEFAULT '{}'
);

-- Reconstruct one cross-service request. The whole reason for a single table.
CREATE INDEX IF NOT EXISTS idx_agent_events_trace ON agent_events(trace_id);

-- "What has this agent been doing?" — the per-agent view.
CREATE INDEX IF NOT EXISTS idx_agent_events_service
  ON agent_events(service_name, timestamp);

-- "Everything that happened for this task / DO instance."
CREATE INDEX IF NOT EXISTS idx_agent_events_instance
  ON agent_events(instance_id) WHERE instance_id IS NOT NULL;

-- Errors first, without scanning the table.
CREATE INDEX IF NOT EXISTS idx_agent_events_errors
  ON agent_events(timestamp) WHERE severity = 'error';

-- Carry the trace onto the existing task ledger so a task row joins to the
-- spans that produced it: `tasks.trace_id = agent_events.trace_id`.
ALTER TABLE tasks ADD COLUMN trace_id TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_trace ON tasks(trace_id) WHERE trace_id IS NOT NULL;
