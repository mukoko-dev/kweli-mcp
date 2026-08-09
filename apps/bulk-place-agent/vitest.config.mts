import path from "node:path";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Runs against REAL workerd with a REAL D1 (SQLite), not a mock. That's the
// point: the D1 ledger and its migrations were entirely unverified —
// including 0003, whose `ALTER TABLE tasks ADD COLUMN trace_id` had never
// actually been applied on top of 0001+0002 anywhere. A broken migration now
// fails here instead of during a deploy.
//
// The worker entrypoint is deliberately NOT bundled: these tests exercise the
// D1 layer (packages/shared's ledger), and pulling in src/index.ts would drag
// the mongodb driver into the isolate for no benefit.
//
// NOTE the API shape: @cloudflare/vitest-pool-workers >= 0.20 (the vitest 4
// line) dropped the `./config` subpath and its `defineWorkersConfig` wrapper
// in favour of the `cloudflareTest` Vite plugin exported from the root. Most
// documentation and examples still show the old form.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      singleWorker: true,
      miniflare: {
        compatibilityDate: "2025-04-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        // Read by the setup file to bring each isolated database up to date.
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(__dirname, "migrations")),
        },
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
