// Acceptance Criterion 2: a CommitPlan with a fault-injected nonexistent
// clause_id for the DERIVED_FROM edge throws CommitError, and neither the
// Circular nor the Clause from that plan is findable afterward — nothing
// partially committed (FR-12).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GraphWriter } from "../../src/commit/graph-writer.js";
import { CircularRepository } from "../../src/repositories/circular.repository.js";
import { ClauseRepository } from "../../src/repositories/clause.repository.js";
import { CommitError } from "../../src/errors.js";
import type { CommitPlan } from "../../src/types.js";
import { startNeo4j, stopNeo4j, migrate, resetGraph, type Neo4jTestContext, CONTAINER_STARTUP_TIMEOUT_MS } from "./helpers/setup.js";

describe("commit atomicity (integration)", () => {
  let ctx: Neo4jTestContext;

  beforeAll(async () => {
    ctx = await startNeo4j();
    await migrate(ctx.driver);
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    if (ctx) await stopNeo4j(ctx);
  });

  beforeEach(async () => {
    await resetGraph(ctx.driver);
  });

  it("rolls back the entire plan when an edge endpoint is missing", async () => {
    const plan: CommitPlan = {
      proposalId: "atomicity-test-1",
      nodes: {
        circulars: [
          {
            circular_id: "atomic-circular-1",
            title: "Test Circular",
            type: "circular",
            category: "test",
            date_issued: "2026-01-01",
            date_effective: "2026-01-10",
            source_hash: "atomic-test-hash-1",
            supersedes_circular_id: null,
            valid_from: "2026-01-10",
            valid_to: null
          }
        ],
        clauses: [
          {
            clause_id: "atomic-clause-1",
            circular_id: "atomic-circular-1",
            para_ref: "1",
            text: "test clause",
            embedding_ref: JSON.stringify([]),
            valid_from: "2026-01-10",
            valid_to: null
          }
        ]
      },
      edges: [
        { type: "PART_OF", clause_id: "atomic-clause-1", circular_id: "atomic-circular-1" },
        // Fault injection: this obligation_id was never created in this
        // plan (and doesn't already exist in the graph) — DERIVED_FROM's
        // MATCH will find zero rows, which GraphWriter.commitProposal
        // must surface as a rolled-back CommitError.
        { type: "DERIVED_FROM", obligation_id: "does-not-exist-obligation", clause_id: "atomic-clause-1" }
      ]
    };

    const writer = new GraphWriter(ctx.driver);
    await expect(writer.commitProposal(plan)).rejects.toBeInstanceOf(CommitError);

    const circularRepo = new CircularRepository(ctx.driver);
    const clauseRepo = new ClauseRepository(ctx.driver);
    expect(await circularRepo.findById("atomic-circular-1")).toBeNull();
    expect(await clauseRepo.findById("atomic-clause-1")).toBeNull();
  }, CONTAINER_STARTUP_TIMEOUT_MS);
});
