// Acceptance Criterion 7: with the clause_embedding_index built and at
// least 5 Clause nodes carrying a populated embedding_ref,
// findSimilarClauses returns at most topK results ordered by descending
// score, and EXPLAIN on the underlying query shows a vector index seek
// (NodeVectorIndexSeek), not a full label scan (FR-20).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GraphWriter } from "../../src/commit/graph-writer.js";
import { findSimilarClauses } from "../../src/vector-search.js";
import { buildDevSampleSetPlan } from "../../seed/fixtures/dev-sample-set.js";
import { startNeo4j, stopNeo4j, migrate, resetGraph, type Neo4jTestContext, CONTAINER_STARTUP_TIMEOUT_MS } from "./helpers/setup.js";

function placeholderQueryEmbedding(): number[] {
  return Array.from({ length: 1536 }, (_, i) => Math.sin(1 * 0.017 + i * 0.031));
}

describe("vector index (integration)", () => {
  let ctx: Neo4jTestContext;

  beforeAll(async () => {
    ctx = await startNeo4j();
    await migrate(ctx.driver);
    await resetGraph(ctx.driver);
    const writer = new GraphWriter(ctx.driver);
    await writer.commitProposal(buildDevSampleSetPlan());
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    if (ctx) await stopNeo4j(ctx);
  });

  it("returns at most topK results ordered by descending score via a real vector index seek", async () => {
    const session = ctx.driver.session();
    try {
      const results = await findSimilarClauses(session, { queryEmbedding: placeholderQueryEmbedding(), topK: 3 });

      expect(results.length).toBeLessThanOrEqual(3);
      expect(results.length).toBeGreaterThan(0);
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }

      // Post-review correction: `db.index.vector.queryNodes` is a stored
      // procedure call, not a native Cypher clause, so Neo4j's planner
      // treats it as an opaque "ProcedureCall" operator in EXPLAIN output
      // — it does not expose a distinct "NodeVectorIndexSeek"-style
      // operator for what happens *inside* the procedure. Confirmed
      // against a real Neo4j 5.23 instance: the original assertion here
      // (`toContain("VectorIndexSeek")`) never matches for this query
      // shape, on any correctly-indexed data, because that operator name
      // simply doesn't appear in the plan tree for procedure-based vector
      // search. What we *can* verify from EXPLAIN — and what actually
      // matters per FR-20 ("MUST use db.index.vector.queryNodes ... MUST
      // NOT fall back to a brute-force scan") — is that the plan (a) does
      // call the correct procedure and (b) contains no full label/node
      // scan operator, which would be the telltale sign of a brute-force
      // fallback.
      const explainResult = await session.executeRead((tx) =>
        tx.run(
          `EXPLAIN CALL db.index.vector.queryNodes('clause_embedding_index', 3, $queryEmbedding) YIELD node, score RETURN node, score`,
          { queryEmbedding: placeholderQueryEmbedding() }
        )
      );
      const planJson = JSON.stringify(explainResult.summary.plan);
      expect(planJson).toContain("db.index.vector.queryNodes");
      expect(planJson).not.toContain("NodeByLabelScan");
      expect(planJson).not.toContain("AllNodesScan");
    } finally {
      await session.close();
    }
  }, CONTAINER_STARTUP_TIMEOUT_MS);
});
