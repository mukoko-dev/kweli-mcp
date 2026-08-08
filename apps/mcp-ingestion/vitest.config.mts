import { defineConfig } from "vitest/config";

// No pure-logic tests live in this app yet (the ones that used to — bulk
// intent expansion, boundary guard — moved to packages/shared with the code
// they test). TODO: OAuth flow / M2M gate integration tests.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    passWithNoTests: true,
  },
});
