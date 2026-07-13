import { defineConfig } from "vitest/config";

// Vitest config for @sentinel-act/report-generation. Node environment
// throughout — this package is pure data transformation + binary file
// generation (no DOM, no Neo4j driver, no Next.js), per Spec 10 §5.6's
// "no Next.js, no Neo4j driver, no filesystem access inside the package"
// constraint. Mirrors packages/graph-db/vitest.config.ts.
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    testTimeout: 30_000
  }
});
