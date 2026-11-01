import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // The Workers runtime module the OAuth provider imports; see the stub.
      "cloudflare:workers": fileURLToPath(
        new URL("./test/cloudflare-workers-stub.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    passWithNoTests: true,
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
  },
});
