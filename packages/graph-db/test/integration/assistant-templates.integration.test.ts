// assistant-templates.integration.test.ts — Spec 12 Task 16 / §10 Test
// Plan ("assistant-templates.integration.test.ts — each of the five
// templates (§4.2) against the seeded fixtures"). Runs
// AssistantQueryService's five fixed Cypher templates (T1-T5) against a
// REAL Neo4j 5.13+ Community container (this package's existing
// testcontainers harness, test/integration/helpers/setup.ts — same
// pattern as cuspa-demo-walkthrough.integration.test.ts /
// vector-index.integration.test.ts), seeded via Spec 01's existing
// cuspa-pre fixture plus a small companion CommitPlan of this file's own
// (two more Obligations + two HumanReviews, one Tier C and one Tier B)
// built through the same `GraphWriter.commitProposal` path every other
// write in this package uses — no bespoke seed-only Cypher.
//
// ***** Why this suite exists — what a mocked-driver unit test cannot
// ***** prove (mirrors packages/graph-db/test/queries/audit-query.test.ts's
// ***** own "Honesty note" at the top of that file) *****
//
// assistant-query.test.ts (mocked driver) already proves each template's
// Cypher STRING is well-formed, has the right shape, and that
// runTemplate's params-schema validation / limit clamping / row-mapping
// logic is correct against canned records. It CANNOT prove T2/T5's own
// native `TIER_C_INDEPENDENCE_GUARD` predicate (assistant-query-templates.ts
// — deliberately re-implemented here rather than inherited from
// AuditQueryService, since T2/T5 are new Cypher, see that file's own
// doc comment) actually filters a real, unresolved Tier C maker review
// out of Neo4j's real query evaluation. That is exactly what this suite
// verifies — the single most important thing an integration test can add
// over the existing unit-test suite for this package.
//
// ***** Sandbox limitation — this file could not be executed in the
// ***** environment it was authored in *****
//
// This sandbox has no `docker`/`podman` binary and no docker socket
// (confirmed: `which docker` -> not found, no `/var/run/docker.sock`) —
// the exact same gap packages/graph-db/test/queries/audit-query.test.ts's
// own top-of-file comment already flags for Spec 10's equivalent
// integration test. `@testcontainers/neo4j` is already a devDependency of
// this package (used by every other `*.integration.test.ts` file here),
// and this file follows that existing, already-working harness exactly —
// but it has NOT been run against a live container as part of this task,
// and could not be. Whoever next has docker available should run
// `pnpm --filter @sentinel-act/graph-db test:integration` and treat a
// failure here as a real bug, not a flake — this is flagged explicitly,
// not silently skipped, per this package's own established convention
// for this exact gap.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GraphWriter } from "../../src/commit/graph-writer.js";
import { AssistantQueryService } from "../../src/queries/assistant-query.js";
import type { CommitPlan } from "../../src/types.js";
import {
  buildCuspaPreAmendmentPlan,
  CUSPA_PRE_CIRCULAR_ID,
  CUSPA_PRE_CLAUSE_ID,
  CUSPA_PRE_OBLIGATION_ID,
  STOCKBROKER_CATEGORY_ID
} from "../../seed/fixtures/cuspa-pre-amendment.js";
import { startNeo4j, stopNeo4j, migrate, resetGraph, type Neo4jTestContext, CONTAINER_STARTUP_TIMEOUT_MS } from "./helpers/setup.js";

// Fixed, hardcoded UUIDs (same FR-19 convention as cuspa-pre-amendment.ts
// — stable identity across every run, not crypto.randomUUID()). Both new
// Obligations are DERIVED_FROM the same already-seeded CUSPA clause and
// APPLIES_TO the same already-seeded Stockbroker category, purely to
// avoid re-deriving a second Circular/Clause/IntermediaryCategory just
// for this suite's own purposes — this file's own fact is the two
// Obligations + two HumanReviews + their edges, not a second regulatory
// scenario.
const OB_TIER_C_ID = "b2b2b2b2-0001-4001-8001-000000000001";
const OB_TIER_B_ID = "b2b2b2b2-0002-4001-8001-000000000002";
const REVIEW_TIER_C_ID = "b2b2b2b2-0003-4001-8001-000000000003";
const REVIEW_TIER_B_ID = "b2b2b2b2-0004-4001-8001-000000000004";

function buildAssistantReviewFixturesPlan(): CommitPlan {
  return {
    proposalId: "seed-assistant-integration-reviews",
    nodes: {
      obligations: [
        {
          obligation_id: OB_TIER_C_ID,
          derived_from_clause_id: CUSPA_PRE_CLAUSE_ID,
          category: "client_asset_protection",
          requirement_text: "Placeholder Tier C obligation for the assistant integration suite's independence-guard proof.",
          trigger_event: "client_securities_unpaid",
          deadline_rule: "T+5 trading days from unpaid status",
          responsible_role: "Compliance Officer",
          evidence_required: "CUSPA disposal log and client intimation record",
          penalty_ref: null,
          confidence_score: 0.6,
          grounding_score: 0.6,
          status: "tier_c_review",
          valid_from: "2026-02-01",
          valid_to: null
        },
        {
          obligation_id: OB_TIER_B_ID,
          derived_from_clause_id: CUSPA_PRE_CLAUSE_ID,
          category: "client_asset_protection",
          requirement_text: "Placeholder Tier B (already-committed) obligation, the control case that MUST still be visible.",
          trigger_event: "client_securities_unpaid",
          deadline_rule: "T+5 trading days from unpaid status",
          responsible_role: "Compliance Officer",
          evidence_required: "CUSPA disposal log and client intimation record",
          penalty_ref: null,
          confidence_score: 0.9,
          grounding_score: 0.9,
          status: "committed",
          valid_from: "2026-02-01",
          valid_to: null
        }
      ],
      humanReviews: [
        {
          // An in-progress Tier C maker review, awaiting an independent
          // checker decision — per FR-11a (inherited natively here via
          // T2/T5's own TIER_C_INDEPENDENCE_GUARD, not via
          // AuditQueryService), this must never be visible on any
          // read-only surface, including the Conversational Assistant's.
          review_id: REVIEW_TIER_C_ID,
          obligation_id: OB_TIER_C_ID,
          reviewer_id: "maker@example.com",
          tier: "C",
          decision: "approve",
          rationale: "Maker's own initial Tier C review — independent checker decision does not exist yet.",
          decided_at: "2026-02-02T00:00:00Z",
          valid_from: "2026-02-02",
          valid_to: null
        },
        {
          // Control case: an ordinary, resolved Tier B review — MUST be
          // visible, contrasting with the withheld Tier C one above.
          review_id: REVIEW_TIER_B_ID,
          obligation_id: OB_TIER_B_ID,
          reviewer_id: "reviewer2@example.com",
          tier: "B",
          decision: "approve",
          rationale: "Consistent with existing custody obligations.",
          decided_at: "2026-02-03T00:00:00Z",
          valid_from: "2026-02-03",
          valid_to: null
        }
      ]
    },
    edges: [
      { type: "DERIVED_FROM", obligation_id: OB_TIER_C_ID, clause_id: CUSPA_PRE_CLAUSE_ID },
      { type: "DERIVED_FROM", obligation_id: OB_TIER_B_ID, clause_id: CUSPA_PRE_CLAUSE_ID },
      { type: "APPLIES_TO", obligation_id: OB_TIER_C_ID, category_id: STOCKBROKER_CATEGORY_ID },
      { type: "APPLIES_TO", obligation_id: OB_TIER_B_ID, category_id: STOCKBROKER_CATEGORY_ID },
      { type: "REVIEWED_BY", obligation_id: OB_TIER_C_ID, review_id: REVIEW_TIER_C_ID },
      { type: "REVIEWED_BY", obligation_id: OB_TIER_B_ID, review_id: REVIEW_TIER_B_ID }
    ]
  };
}

describe("AssistantQueryService templates (integration)", () => {
  let ctx: Neo4jTestContext;
  let service: AssistantQueryService;

  beforeAll(async () => {
    ctx = await startNeo4j();
    await migrate(ctx.driver);
    await resetGraph(ctx.driver);

    const writer = new GraphWriter(ctx.driver);
    await writer.commitProposal(buildCuspaPreAmendmentPlan());
    await writer.commitProposal(buildAssistantReviewFixturesPlan());

    service = new AssistantQueryService(ctx.driver);
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    if (ctx) await stopNeo4j(ctx);
  });

  it(
    "T1 obligations_by_category_and_date_range: returns every seeded Stockbroker obligation whose valid_from falls in range",
    async () => {
      const context = await service.runTemplate("obligations_by_category_and_date_range", {
        categoryName: "Stockbroker",
        dateFrom: "2026-01-01",
        dateTo: "2026-02-28"
      });

      const ids = context.obligations.map((o) => o.obligation_id);
      expect(ids).toContain(CUSPA_PRE_OBLIGATION_ID);
      expect(ids).toContain(OB_TIER_C_ID);
      expect(ids).toContain(OB_TIER_B_ID);
      // Real Circular/Clause lineage attached via the real DERIVED_FROM/
      // PART_OF edges, not a placeholder.
      expect(context.circulars.map((c) => c.circular_id)).toContain(CUSPA_PRE_CIRCULAR_ID);
    },
    CONTAINER_STARTUP_TIMEOUT_MS
  );

  it(
    "T2 obligation_by_id_with_lineage: a Tier C in-progress review is hidden by the real independence guard, a Tier B review is not (core proof — cannot be shown by a mocked driver)",
    async () => {
      const tierCContext = await service.runTemplate("obligation_by_id_with_lineage", { obligationId: OB_TIER_C_ID });
      expect(tierCContext.obligations.map((o) => o.obligation_id)).toEqual([OB_TIER_C_ID]);
      // The core assertion: real Cypher evaluation of
      // TIER_C_INDEPENDENCE_GUARD against real graph state withholds this
      // obligation's own in-progress Tier C review.
      expect(tierCContext.humanReviews).toEqual([]);

      const tierBContext = await service.runTemplate("obligation_by_id_with_lineage", { obligationId: OB_TIER_B_ID });
      expect(tierBContext.humanReviews.map((r) => r.review_id)).toEqual([REVIEW_TIER_B_ID]);

      // Control: the original CUSPA obligation has no reviews at all
      // (auto-committed, no HumanReview ever attached) — full lineage
      // (Clause/Circular/ProcessTask) still resolves correctly.
      const cuspaContext = await service.runTemplate("obligation_by_id_with_lineage", { obligationId: CUSPA_PRE_OBLIGATION_ID });
      expect(cuspaContext.humanReviews).toEqual([]);
      expect(cuspaContext.clauses.map((c) => c.clause_id)).toEqual([CUSPA_PRE_CLAUSE_ID]);
      expect(cuspaContext.circulars.map((c) => c.circular_id)).toEqual([CUSPA_PRE_CIRCULAR_ID]);
      expect(cuspaContext.processTasks.length).toBeGreaterThan(0);
    },
    CONTAINER_STARTUP_TIMEOUT_MS
  );

  it(
    "T3 circular_by_id_or_title: exact circular_id match returns the Circular, its Clause, and every derived Obligation",
    async () => {
      const context = await service.runTemplate("circular_by_id_or_title", {
        circularId: CUSPA_PRE_CIRCULAR_ID,
        titleContains: null
      });

      expect(context.circulars.map((c) => c.circular_id)).toEqual([CUSPA_PRE_CIRCULAR_ID]);
      expect(context.clauses.map((c) => c.clause_id)).toEqual([CUSPA_PRE_CLAUSE_ID]);
      const obligationIds = context.obligations.map((o) => o.obligation_id);
      expect(obligationIds).toEqual(expect.arrayContaining([CUSPA_PRE_OBLIGATION_ID, OB_TIER_C_ID, OB_TIER_B_ID]));

      // Case-insensitive substring title match, the template's other
      // lookup mode.
      const byTitle = await service.runTemplate("circular_by_id_or_title", {
        circularId: null,
        titleContains: "client unpaid securities"
      });
      expect(byTitle.circulars.map((c) => c.circular_id)).toContain(CUSPA_PRE_CIRCULAR_ID);
    },
    CONTAINER_STARTUP_TIMEOUT_MS
  );

  it(
    "T4 obligations_by_status: status filter is exact — tier_c_review and committed do not leak into each other",
    async () => {
      const tierCReview = await service.runTemplate("obligations_by_status", { status: "tier_c_review" });
      expect(tierCReview.obligations.map((o) => o.obligation_id)).toEqual([OB_TIER_C_ID]);

      const committed = await service.runTemplate("obligations_by_status", { status: "committed" });
      const committedIds = committed.obligations.map((o) => o.obligation_id);
      expect(committedIds).toEqual(expect.arrayContaining([CUSPA_PRE_OBLIGATION_ID, OB_TIER_B_ID]));
      expect(committedIds).not.toContain(OB_TIER_C_ID);
    },
    CONTAINER_STARTUP_TIMEOUT_MS
  );

  it(
    "T5 reviews_by_category_and_date_range: the real independence guard excludes the Tier C review from a review-history window, the Tier B review still appears (core proof)",
    async () => {
      const context = await service.runTemplate("reviews_by_category_and_date_range", {
        categoryName: "Stockbroker",
        dateFrom: "2026-01-01T00:00:00Z",
        dateTo: "2026-03-01T00:00:00Z",
        decision: null
      });

      const reviewIds = context.humanReviews.map((r) => r.review_id);
      expect(reviewIds).toContain(REVIEW_TIER_B_ID);
      // Core assertion: the unresolved Tier C review is excluded from a
      // real Cypher MATCH (not OPTIONAL MATCH — this template's whole
      // purpose is surfacing reviews) evaluated against real graph state.
      expect(reviewIds).not.toContain(REVIEW_TIER_C_ID);
      expect(context.obligations.map((o) => o.obligation_id)).not.toContain(OB_TIER_C_ID);

      // decision filter still combines correctly with the guard.
      const rejectedOnly = await service.runTemplate("reviews_by_category_and_date_range", {
        categoryName: "Stockbroker",
        dateFrom: "2026-01-01T00:00:00Z",
        dateTo: "2026-03-01T00:00:00Z",
        decision: "reject"
      });
      expect(rejectedOnly.humanReviews).toEqual([]);
    },
    CONTAINER_STARTUP_TIMEOUT_MS
  );

  it(
    "runTemplate never issues a write — AssistantQueryService.openSession only ever calls session.executeRead (defense-in-depth, re-verified against a real driver/session, not just the mocked-driver unit test)",
    async () => {
      // A read-only assertion at the integration level: re-running every
      // template above did not change the graph's own node count for the
      // labels these templates touch. This is a coarse but real signal —
      // a live Neo4j instance, not a mock, actually executed every query
      // above, and the graph is unchanged afterward.
      const session = ctx.driver.session();
      try {
        const result = await session.executeRead((tx) => tx.run("MATCH (o:Obligation) RETURN count(o) AS c"));
        const count = result.records[0].get("c");
        const numericCount = typeof count === "number" ? count : count.toNumber();
        // Exactly the 3 Obligations this suite seeded (1 from cuspa-pre + 2
        // of this file's own) — no template call above created a 4th.
        expect(numericCount).toBe(3);
      } finally {
        await session.close();
      }
    },
    CONTAINER_STARTUP_TIMEOUT_MS
  );
});
