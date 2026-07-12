// Thin CLI wrapper around runMigrations(), used by the "migrate" npm
// script (`pnpm --filter @sentinel-act/graph-db migrate`) and again in
// CI before integration tests run.
import { getDriver, verifyConnectivity, closeDriver } from "../driver.js";
import { runMigrations } from "./runner.js";

async function main(): Promise<void> {
  const driver = getDriver();
  await verifyConnectivity(driver);
  const result = await runMigrations(driver);
  console.log(JSON.stringify(result, null, 2));
  await closeDriver();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
