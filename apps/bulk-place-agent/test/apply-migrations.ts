// Apply the real migrations/*.sql to each test database before any test runs.
//
// This is what makes the suite a genuine check on the migrations themselves:
// if 0003 can't apply on top of 0001+0002, every test in this directory fails
// loudly here rather than at `wrangler d1 migrations apply` time.

import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  }
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
