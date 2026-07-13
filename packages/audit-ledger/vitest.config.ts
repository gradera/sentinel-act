import { defineConfig } from "vitest/config";

// Vitest config for @sentinel-act/audit-ledger. Node environment
// throughout. Unit tests (mocked `pg` Pool) and integration tests (real
// Postgres via testcontainers) are split by npm script glob, not by
// separate config files — see package.json's "test" vs "test:integration"
// scripts, mirroring packages/graph-db/vitest.config.ts.
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    testTimeout: 30_000
  }
});
