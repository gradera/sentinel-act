import { defineConfig } from "vitest/config";

// Vitest config for @sentinel-act/review-contracts. Node environment,
// no globals (every test file must explicitly import from "vitest"),
// mirrors packages/audit-ledger/vitest.config.ts and
// packages/graph-db/vitest.config.ts.
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    testTimeout: 30_000
  }
});
