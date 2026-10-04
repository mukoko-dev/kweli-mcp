-- Daily AI request budget (src/ai-budget.ts). One row per UTC day; each model
-- call increments `used` with a single atomic upsert. A counter, not a log:
-- rows are tiny and one is added per day.
--
-- The same table as mukoko-dev/kweli workers/fundi-ingestion migration 0003:
-- both workers share this D1, so the budget is one pool for the Fundi place
-- agents. IF NOT EXISTS makes either order of application safe.

CREATE TABLE IF NOT EXISTS ai_budget (
  day  TEXT PRIMARY KEY,           -- YYYY-MM-DD (UTC)
  used INTEGER NOT NULL DEFAULT 0  -- model requests made that day
);
