// Shared testcontainers setup for every *.integration.test.ts file. Each
// integration test file starts its own Neo4jContainer (isolation over
// speed — these are not meant to run in the fast inner dev loop) and runs
// migrations against it before making any assertions, exactly like a real
// deploy would (migrate, then use).
//
// Neo4j 5.13+ is required (native CREATE VECTOR INDEX syntax, spec §3
// External dependency) — @testcontainers/neo4j's own default image
// ("neo4j:4.4.12") is too old, so every caller here pins an explicit 5.x
// community image tag.
import { Neo4jContainer, type StartedNeo4jContainer } from "@testcontainers/neo4j";
import neo4j, { type Driver } from "neo4j-driver";
import { runMigrations } from "../../../src/migrations/runner.js";

export const NEO4J_TEST_IMAGE = "neo4j:5.23-community";
/** Container startup (image pull + Neo4j boot) can comfortably exceed the
 *  package's default 30s vitest testTimeout — every integration test's
 *  beforeAll uses this instead. */
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

/** Runs the package's real migration runner against the freshly-started
 *  container — every integration test operates on a migrated schema, the
 *  same as a real deploy, per Acceptance Criterion 1's own premise. */
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

export async function countNodesByLabel(driver: Driver, label: string): Promise<number> {
  const session = driver.session();
  try {
    const result = await session.executeRead((tx) => tx.run(`MATCH (n:${label}) RETURN count(n) AS c`));
    const value = result.records[0]?.get("c");
    return neo4j.isInt(value) ? value.toNumber() : Number(value ?? 0);
  } finally {
    await session.close();
  }
}
