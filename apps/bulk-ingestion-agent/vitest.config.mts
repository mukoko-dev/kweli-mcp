import { defineConfig } from "vitest/config";

// The deterministic skill-logic tests (Plus Code, classification, the
// description guard, the boundary guard, bulk-intent generators) live in
// packages/shared and packages/skills, which this app depends on. This
// config exists so `pnpm test` here succeeds today (no agent-level
// integration tests yet — TODO once Miniflare Durable Object test harness
// is wired up) and doesn't block `turbo run test` across the workspace.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    passWithNoTests: true,
  },
});
