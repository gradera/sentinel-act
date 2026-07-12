import { defineConfig } from "vitest/config";

// Vitest config for @sentinel-act/orchestrator, mirroring
// packages/graph-db/vitest.config.ts. Node environment (not jsdom's own
// vitest "environment" option) because the Regulatory Watch agent uses
// jsdom itself, directly, as a library (parsing fixture HTML strings) —
// it does not need a simulated browser `window`/`document` global.
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    testTimeout: 30_000
  }
});
