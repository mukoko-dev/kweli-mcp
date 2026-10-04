// Daily AI request budget for the bulk place agent's model calls.
//
// One row per UTC day in the D1 ledger (`ai_budget`, migration 0004). The
// same table mukoko-dev/kweli's fundi-ingestion counts in — both workers share
// this D1, so the budget is one pool for the Fundi place agents. Each
// model call reserves one request with a single upsert that increments and
// returns the new count, so concurrent tasks (one FundiAgent per task) can
// never both read "one left" and both spend it. KV is not used: it is not
// atomic.
//
// Fails CLOSED. If the counter cannot be read, the call is not made: a place
// written without a description stays re-enrichable, while an unmetered
// pipeline is the cost this budget exists to prevent.

export const DEFAULT_DAILY_BUDGET = 2000;

export function resolveDailyBudget(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_DAILY_BUDGET;
}

export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// Returns true when the request fits in today's budget (and counts it).
export async function reserveAiRequest(env: Env): Promise<boolean> {
  const budget = resolveDailyBudget(env.FUNDI_AI_DAILY_BUDGET);
  if (budget === 0) return false;
  const day = utcDay();
  try {
    const row = await env.DB.prepare(
      `INSERT INTO ai_budget (day, used) VALUES (?1, 1)
       ON CONFLICT(day) DO UPDATE SET used = used + 1
       RETURNING used`,
    )
      .bind(day)
      .first<{ used: number }>();
    const used = row?.used ?? Number.POSITIVE_INFINITY;
    if (used > budget) {
      // Logged once, on the first refusal of the day, not on every call.
      if (used === budget + 1) {
        console.warn(
          JSON.stringify({
            worker: "kweli-bulk-place-agent",
            event: "ai_budget.exhausted",
            day,
            budget,
          }),
        );
      }
      return false;
    }
    return true;
  } catch (e) {
    console.error(
      JSON.stringify({
        worker: "kweli-bulk-place-agent",
        event: "ai_budget.unavailable",
        error: String(e),
      }),
    );
    return false;
  }
}
