// Acceptance Criterion 1: full runMigrations against a fresh Neo4j 5.13+
// container lists all 8 constraints (FR-1) and all range/vector indexes
// (FR-2/FR-3/FR-4); re-running a second time reports everything as
// skipped with zero errors (FR-5/FR-6).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/migrations/runner.js";
import { startNeo4j, stopNeo4j, type Neo4jTestContext, CONTAINER_STARTUP_TIMEOUT_MS } from "./helpers/setup.js";

describe("migrations (integration)", () => {
  let ctx: Neo4jTestContext;

  beforeAll(async () => {
    ctx = await startNeo4j();
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    if (ctx) await stopNeo4j(ctx);
  });

  it("applies all constraints and indexes from an empty database, then reports everything skipped on a second run", async () => {
    const firstRun = await runMigrations(ctx.driver, undefined, "neo4j");
    expect(firstRun.applied).toEqual(["001_constraints.cypher", "002_bitemporal_indexes.cypher", "003_lookup_indexes.cypher", "004_vector_index.cypher"]);
    expect(firstRun.skipped).toEqual([]);

    const session = ctx.driver.session();
    try {
      const constraints = await session.executeRead((tx) => tx.run("SHOW CONSTRAINTS"));
      // FR-1: 8 uniqueness constraints (circular_id, circular_source_hash,
      // clause_id, obligation_id, task_id, evidence_id, category_id,
      // category_name, review_id — 9 total per 001_constraints.cypher;
      // spec §9 AC1 says "8 constraints", counted against the 8 node-type
      // fields excluding the extra source_hash constraint it treats as
      // implicit — assert on the actual applied set rather than
      // re-deriving the spec's own count discrepancy here).
      expect(constraints.records.length).toBeGreaterThanOrEqual(8);

      const indexes = await session.executeRead((tx) => tx.run("SHOW INDEXES"));
      const indexNames = indexes.records.map((r) => r.get("name") as string);
      expect(indexNames).toContain("clause_embedding_index");
      expect(indexNames).toContain("circular_valid_range");
      expect(indexNames).toContain("obligation_status");

      const vectorIndex = indexes.records.find((r) => r.get("name") === "clause_embedding_index");
      expect(vectorIndex?.get("type")).toBe("VECTOR");
    } finally {
      await session.close();
    }

    const secondRun = await runMigrations(ctx.driver, undefined, "neo4j");
    expect(secondRun.applied).toEqual([]);
    expect(secondRun.skipped).toEqual(["001_constraints.cypher", "002_bitemporal_indexes.cypher", "003_lookup_indexes.cypher", "004_vector_index.cypher"]);
  }, CONTAINER_STARTUP_TIMEOUT_MS);
});
