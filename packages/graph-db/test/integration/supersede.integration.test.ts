// Acceptance Criteria 3 and 4, against the real cuspa-pre fixture data —
// the exact CUSPA demo assertion: supersede() closes the old obligation's
// valid_to and creates the linked new one (AC3), and the point-in-time
// query flips exactly at the amendment boundary (AC4).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GraphWriter } from "../../src/commit/graph-writer.js";
import { ObligationRepository } from "../../src/repositories/obligation.repository.js";
import { findObligationsAsOf } from "../../src/point-in-time.js";
import { buildCuspaPreAmendmentPlan, CUSPA_PRE_OBLIGATION_ID, STOCKBROKER_CATEGORY_ID } from "../../seed/fixtures/cuspa-pre-amendment.js";
import { startNeo4j, stopNeo4j, migrate, resetGraph, type Neo4jTestContext, CONTAINER_STARTUP_TIMEOUT_MS } from "./helpers/setup.js";

describe("supersede (integration)", () => {
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

  it("AC3: supersede() closes old.valid_to, creates the new obligation, and links SUPERSEDES", async () => {
    const obligationRepo = new ObligationRepository(ctx.driver);

    const { old, created } = await obligationRepo.supersede({
      oldObligationId: CUSPA_PRE_OBLIGATION_ID,
      newObligation: {
        obligation_id: "cuspa-post-obligation-manual",
        derived_from_clause_id: "cuspa-post-clause-manual",
        category: "client_asset_protection",
        requirement_text: "revised CUSPA requirement",
        trigger_event: "client_securities_unpaid",
        deadline_rule: "T+3 trading days",
        responsible_role: "Compliance Officer",
        evidence_required: "revised CUSPA disposal log",
        penalty_ref: null,
        confidence_score: 0.93,
        grounding_score: 0.9,
        status: "committed",
        valid_from: "2026-07-03",
        valid_to: null
      },
      effectiveDate: "2026-07-03"
    });

    expect(old.valid_to).toBe("2026-07-03");
    expect(created.valid_from).toBe("2026-07-03");
    expect(created.valid_to).toBeNull();

    const reFetchedOld = await obligationRepo.findById(CUSPA_PRE_OBLIGATION_ID);
    expect(reFetchedOld?.valid_to).toBe("2026-07-03");

    const lineage = await obligationRepo.findLineage(created.obligation_id);
    expect(lineage.map((o) => o.obligation_id)).toContain(CUSPA_PRE_OBLIGATION_ID);
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  it("AC4: the point-in-time query flips exactly at the amendment boundary", async () => {
    const obligationRepo = new ObligationRepository(ctx.driver);
    await obligationRepo.supersede({
      oldObligationId: CUSPA_PRE_OBLIGATION_ID,
      newObligation: {
        obligation_id: "cuspa-post-obligation-manual-2",
        derived_from_clause_id: "cuspa-post-clause-manual-2",
        category: "client_asset_protection",
        requirement_text: "revised CUSPA requirement",
        trigger_event: "client_securities_unpaid",
        deadline_rule: "T+3 trading days",
        responsible_role: "Compliance Officer",
        evidence_required: "revised CUSPA disposal log",
        penalty_ref: null,
        confidence_score: 0.93,
        grounding_score: 0.9,
        status: "committed",
        valid_from: "2026-07-03",
        valid_to: null
      },
      effectiveDate: "2026-07-03"
    });

    // FR-11: supersede() deliberately does NOT copy the old obligation's
    // outgoing structural edges — the caller supplies the new node's
    // edges explicitly. This direct-supersede test bypasses
    // GraphWriter.commitProposal (which is what a real caller would use
    // to supply CommitPlan.edges), so it recreates just the one edge the
    // canonical §4.3 query needs to filter on, the same way a real caller
    // would via CommitPlan.edges.
    const edgeSession = ctx.driver.session();
    try {
      await edgeSession.executeWrite((tx) =>
        tx.run(
          `MATCH (o:Obligation {obligation_id: $obligationId})
           MATCH (c:IntermediaryCategory {category_id: $categoryId})
           CREATE (o)-[:APPLIES_TO]->(c)`,
          { obligationId: "cuspa-post-obligation-manual-2", categoryId: STOCKBROKER_CATEGORY_ID }
        )
      );
    } finally {
      await edgeSession.close();
    }

    const session = ctx.driver.session();
    try {
      const before = await findObligationsAsOf(session, { asOfDate: "2026-07-01", categoryName: "Stockbroker" });
      const after = await findObligationsAsOf(session, { asOfDate: "2026-07-05", categoryName: "Stockbroker" });

      expect(before.map((o) => o.obligation_id)).toContain(CUSPA_PRE_OBLIGATION_ID);
      expect(before.map((o) => o.obligation_id)).not.toContain("cuspa-post-obligation-manual-2");

      expect(after.map((o) => o.obligation_id)).toContain("cuspa-post-obligation-manual-2");
      expect(after.map((o) => o.obligation_id)).not.toContain(CUSPA_PRE_OBLIGATION_ID);
    } finally {
      await session.close();
    }
  }, CONTAINER_STARTUP_TIMEOUT_MS);
});
