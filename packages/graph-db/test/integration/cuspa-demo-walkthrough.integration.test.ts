// cuspa-demo-walkthrough.integration.test.ts — the automated proxy for
// what the live 3 July 2026 CUSPA / Paragraph 46 demo shows on stage.
// Seeds cuspa-pre, applies cuspa-post via the real
// GraphWriter.commitProposal path (not a hand-rolled fixture write — per
// FR-18, this exercises the same commit+supersede path the real
// Watch -> Orchestrator pipeline would use), then runs the exact §4.3
// point-in-time query for both 2026-07-01 and 2026-07-05 and asserts the
// obligation flips exactly at the boundary. Treat this as the single most
// important test in this package (spec §10).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GraphWriter } from "../../src/commit/graph-writer.js";
import { findObligationsAsOf } from "../../src/point-in-time.js";
import {
  buildCuspaPreAmendmentPlan,
  CUSPA_PRE_OBLIGATION_ID,
  CUSPA_PRE_CIRCULAR_ID
} from "../../seed/fixtures/cuspa-pre-amendment.js";
import {
  buildCuspaPostAmendmentPlan,
  CUSPA_POST_OBLIGATION_ID,
  CUSPA_POST_CIRCULAR_ID,
  CUSPA_AMENDMENT_EFFECTIVE_DATE
} from "../../seed/fixtures/cuspa-post-amendment.js";
import { CircularRepository } from "../../src/repositories/circular.repository.js";
import { startNeo4j, stopNeo4j, migrate, resetGraph, type Neo4jTestContext, CONTAINER_STARTUP_TIMEOUT_MS } from "./helpers/setup.js";

describe("CUSPA demo walkthrough (integration)", () => {
  let ctx: Neo4jTestContext;

  beforeAll(async () => {
    ctx = await startNeo4j();
    await migrate(ctx.driver);
    await resetGraph(ctx.driver);
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    if (ctx) await stopNeo4j(ctx);
  });

  it("flips the live Stockbroker CUSPA obligation exactly at the 2026-07-03 amendment boundary", async () => {
    const writer = new GraphWriter(ctx.driver);

    // 1. Pre-amendment state — what the live demo starts from.
    await writer.commitProposal(buildCuspaPreAmendmentPlan());

    // 2. The amendment itself, through the real commit+supersede path.
    await writer.commitProposal(buildCuspaPostAmendmentPlan());

    expect(CUSPA_AMENDMENT_EFFECTIVE_DATE).toBe("2026-07-03");

    // 3. The exact §4.3 canonical query, both sides of the boundary.
    const session = ctx.driver.session();
    try {
      const before = await findObligationsAsOf(session, { asOfDate: "2026-07-01", categoryName: "Stockbroker" });
      const after = await findObligationsAsOf(session, { asOfDate: "2026-07-05", categoryName: "Stockbroker" });

      const beforeIds = before.map((o) => o.obligation_id);
      const afterIds = after.map((o) => o.obligation_id);

      expect(beforeIds).toContain(CUSPA_PRE_OBLIGATION_ID);
      expect(beforeIds).not.toContain(CUSPA_POST_OBLIGATION_ID);

      expect(afterIds).toContain(CUSPA_POST_OBLIGATION_ID);
      expect(afterIds).not.toContain(CUSPA_PRE_OBLIGATION_ID);

      // The Circular lineage flips the same way, via CircularRepository
      // (not the Obligation-scoped findObligationsAsOf helper) — the
      // amendment's supersedes_circular_id/SUPERSEDES edge should also be
      // in place.
      const circularRepo = new CircularRepository(ctx.driver);
      const preCircular = await circularRepo.findById(CUSPA_PRE_CIRCULAR_ID);
      const postCircular = await circularRepo.findById(CUSPA_POST_CIRCULAR_ID);
      expect(preCircular?.valid_to).toBe(CUSPA_AMENDMENT_EFFECTIVE_DATE);
      expect(postCircular?.supersedes_circular_id).toBe(CUSPA_PRE_CIRCULAR_ID);
      expect(postCircular?.valid_to).toBeNull();
    } finally {
      await session.close();
    }
  }, CONTAINER_STARTUP_TIMEOUT_MS);
});
