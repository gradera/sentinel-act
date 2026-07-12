// Acceptance Criterion 6: two concurrent ObligationRepository.supersede
// calls targeting the same oldObligationId, via two sessions on the same
// driver — exactly one resolves, the other rejects ConflictError, and
// valid_to ends up set to exactly one of the two effectiveDates (FR-14).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GraphWriter } from "../../src/commit/graph-writer.js";
import { ObligationRepository } from "../../src/repositories/obligation.repository.js";
import { ConflictError } from "../../src/errors.js";
import { buildCuspaPreAmendmentPlan, CUSPA_PRE_OBLIGATION_ID } from "../../seed/fixtures/cuspa-pre-amendment.js";
import { startNeo4j, stopNeo4j, migrate, resetGraph, type Neo4jTestContext, CONTAINER_STARTUP_TIMEOUT_MS } from "./helpers/setup.js";

describe("concurrent supersede (integration)", () => {
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
    const writer = new GraphWriter(ctx.driver);
    await writer.commitProposal(buildCuspaPreAmendmentPlan());
  });

  it("exactly one of two concurrent supersede calls wins; the other throws ConflictError", async () => {
    // Two independent repository instances sharing the same Driver (and
    // therefore its connection pool) but issuing genuinely concurrent
    // transactions — models two Orchestrator workflow runs racing to
    // supersede the same live Obligation.
    const repoA = new ObligationRepository(ctx.driver);
    const repoB = new ObligationRepository(ctx.driver);

    const newObligationBase = {
      derived_from_clause_id: "concurrent-test-clause",
      category: "client_asset_protection",
      requirement_text: "req",
      trigger_event: "trigger",
      deadline_rule: "T+3",
      responsible_role: "Compliance Officer",
      evidence_required: "log",
      penalty_ref: null,
      confidence_score: 0.9,
      grounding_score: 0.9,
      status: "committed" as const,
      valid_to: null
    };

    const [resultA, resultB] = await Promise.allSettled([
      repoA.supersede({
        oldObligationId: CUSPA_PRE_OBLIGATION_ID,
        newObligation: { ...newObligationBase, obligation_id: "concurrent-winner-a", valid_from: "2026-07-03" },
        effectiveDate: "2026-07-03"
      }),
      repoB.supersede({
        oldObligationId: CUSPA_PRE_OBLIGATION_ID,
        newObligation: { ...newObligationBase, obligation_id: "concurrent-winner-b", valid_from: "2026-08-01" },
        effectiveDate: "2026-08-01"
      })
    ]);

    const outcomes = [resultA, resultB];
    const fulfilled = outcomes.filter((r) => r.status === "fulfilled");
    const rejected = outcomes.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);

    const obligationRepo = new ObligationRepository(ctx.driver);
    const finalOld = await obligationRepo.findById(CUSPA_PRE_OBLIGATION_ID);
    expect(["2026-07-03", "2026-08-01"]).toContain(finalOld?.valid_to);
  }, CONTAINER_STARTUP_TIMEOUT_MS);
});
