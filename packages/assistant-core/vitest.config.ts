import { defineConfig } from "vitest/config";

// Vitest config for @sentinel-act/assistant-core. Node environment
// throughout — this package is framework-agnostic (no Next.js, no direct
// Neo4j driver; it takes a packages/graph-db client as a constructor
// argument, §4.1) and every unit test mocks the Mastra Agent / graph-db
// service dependencies it's given. Mirrors packages/report-generation/
// vitest.config.ts.
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    testTimeout: 30_000
  }
});
