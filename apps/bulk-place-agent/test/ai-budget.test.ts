// The daily AI request budget, against a real D1 in real workerd — so the
// atomic upsert in migration 0004 is exercised, not a mock of it.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DAILY_BUDGET,
  reserveAiRequest,
  resolveDailyBudget,
  utcDay,
} from "../src/ai-budget";

const withBudget = (budget: string) =>
  ({ ...env, FUNDI_AI_DAILY_BUDGET: budget }) as unknown as Env;

describe("ai budget", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM ai_budget").run();
  });

  it("parses the budget var with a safe default", () => {
    expect(resolveDailyBudget("500")).toBe(500);
    expect(resolveDailyBudget(undefined)).toBe(DEFAULT_DAILY_BUDGET);
    expect(resolveDailyBudget("-3")).toBe(DEFAULT_DAILY_BUDGET);
  });

  it("counts every reservation and refuses once the day is spent", async () => {
    const e = withBudget("3");
    const results = await Promise.all(
      Array.from({ length: 5 }, () => reserveAiRequest(e)),
    );
    // Concurrent callers: exactly the budget gets through, no more.
    expect(results.filter(Boolean)).toHaveLength(3);
    const row = await env.DB.prepare("SELECT used FROM ai_budget WHERE day = ?")
      .bind(utcDay())
      .first<{ used: number }>();
    expect(row?.used).toBe(5);
  });

  it("refuses everything at a budget of 0", async () => {
    expect(await reserveAiRequest(withBudget("0"))).toBe(false);
  });
});
