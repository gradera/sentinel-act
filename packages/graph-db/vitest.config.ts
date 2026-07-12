import { defineConfig } from "vitest/config";

// Vitest config for @sentinel-act/graph-db. Node environment throughout
// (no DOM code in this package). Unit tests (mocked neo4j-driver) and
// integration tests (real Neo4j via testcontainers) are split by npm
// script glob, not by separate config files — see package.json's
// "test" vs "test:integration" scripts.
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    testTimeout: 30_000
  }
});
