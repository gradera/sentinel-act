// Shared testcontainers setup for assistant-core's *.integration.test.ts
// files — mirrors packages/graph-db/test/integration/helpers/setup.ts
// exactly (same image pin, same startup-timeout convention), but built
// only from @sentinel-act/graph-db's PUBLIC exports (`runMigrations`),
// never a relative reach into that package's internal src/ files — this
// package only ever depends on graph-db's published contract, same rule
// as every non-test file in packages/assistant-core/src.
import { Neo4jContainer, type StartedNeo4jContainer } from "@testcontainers/neo4j";
import neo4j, { type Driver } from "neo4j-driver";
import { runMigrations } from "@sentinel-act/graph-db";

export const NEO4J_TEST_IMAGE = "neo4j:5.23-community";
export const CONTAINER_STARTUP_TIMEOUT_MS = 180_000;

export interface Neo4jTestContext {
  container: StartedNeo4jContainer;
  driver: Driver;
}

export async function startNeo4j(): Promise<Neo4jTestContext> {
  const container = await new Neo4jContainer(NEO4J_TEST_IMAGE).withPassword("sentinel-test-pw").start();
  const driver = neo4j.driver(container.getBoltUri(), neo4j.auth.basic(container.getUsername(), container.getPassword()));
  await driver.verifyConnectivity();
  return { container, driver };
}

export async function stopNeo4j(ctx: Neo4jTestContext): Promise<void> {
  await ctx.driver.close();
  await ctx.container.stop();
}

export async function migrate(driver: Driver): Promise<ReturnType<typeof runMigrations>> {
  return runMigrations(driver, undefined, "neo4j");
}

export async function resetGraph(driver: Driver): Promise<void> {
  const session = driver.session();
  try {
    await session.executeWrite((tx) => tx.run("MATCH (n) DETACH DELETE n"));
  } finally {
    await session.close();
  }
}
