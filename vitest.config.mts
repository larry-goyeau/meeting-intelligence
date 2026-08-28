import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
    reporters: ["default"],
    /**
     * Force the offline provider, whatever the developer's shell holds.
     *
     * Without this, anyone with OPENAI_API_KEY exported runs the whole suite against
     * the real API: it took the run from 2 s to 26 s, cost money, and — worst of the
     * three — made assertions about retrieval depend on a remote model that can
     * change under them. Tests should fail for one reason only.
     */
    env: { OPENAI_API_KEY: "", OPENAI_BASE_URL: "" },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
