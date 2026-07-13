// Thin CLI wrapper around runMigrations(), used by the "migrate" npm
// script (`pnpm --filter @sentinel-act/audit-ledger migrate`) and again
// in CI before integration tests run. Mirrors
// packages/graph-db/src/migrations/cli.ts.
import { getPool, verifyConnectivity, closePool } from "../driver.js";
import { runMigrations } from "./runner.js";

async function main(): Promise<void> {
  const pool = getPool();
  await verifyConnectivity(pool);
  const result = await runMigrations(pool);
  console.log(JSON.stringify(result, null, 2));
  await closePool();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
