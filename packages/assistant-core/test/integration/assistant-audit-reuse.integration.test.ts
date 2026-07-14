// assistant-audit-reuse.integration.test.ts — Spec 12 Task 16 / §10 Test
// Plan ("assistant-audit-reuse.integration.test.ts — the three
// AuditQueryService-backed intents return identical results to calling
// AuditQueryService directly, proves FR-6's no-duplication guarantee").
//
// review_history_by_obligation/_circular/_reviewer are the three
// structured intents that call AuditQueryService.findByObligationId/
// .search(...) UNMODIFIED (structured-retrieval.ts, FR-6) rather than
// running any new Cypher of their own. Code review already shows this
// (retrieveStructured's dispatch literally forwards to
// `deps.auditQueryService.findByObligationId(...)`/`.search(...)`), and
// structured-retrieval.test.ts already unit-tests this dispatch with a
// mocked service. What NEITHER of those can prove is that this holds
// against a REAL running Neo4j instance with real data — this file seeds
// one small, self-contained scenario (a Circular/Clause/Obligation/
// HumanReview, via `GraphWriter.commitProposal`, the same path every
// other write in this monorepo uses) and asserts retrieveStructured's
// resulting AssistantGraphContext reflects EXACTLY the same review/
// obligation facts a direct `AuditQueryService.findByObligationId`/
// `.search()` call returns for the same parameters — no separate,
// silently-diverging Cypher path.
//
// Built entirely from @sentinel-act/graph-db's PUBLIC exports
// (GraphWriter, AuditQueryService, AssistantQueryService, runMigrations)
// — this file does not reach into graph-db's seed/fixtures (not part of
// that package's exports map, `{ "." : "./src/index.ts" }` only), so it
// constructs its own small, self-contained CommitPlan rather than
// reusing cuspa-pre/post (those fixtures don't include a HumanReview at
// all, which this file specifically needs).
//
// ***** Sandbox limitation — could not be executed where it was authored
// ***** (same gap as packages/graph-db/test/integration/
// ***** assistant-templates.integration.test.ts's own header comment) *****
// No docker/podman binary, no docker socket, confirmed. Flagged
// explicitly — whoever next has docker available should run
// `pnpm --filter @sentinel-act/assistant-core test:integration`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AssistantQueryService, AuditQueryService, GraphWriter } from "@sentinel-act/graph-db";
import type { CommitPlan } from "@sentinel-act/graph-db";
import { retrieveStructured } from "../../src/structured-retrieval.js";
import type { AssistantSlots } from "../../src/types.js";
import { startNeo4j, stopNeo4j, migrate, resetGraph, type Neo4jTestContext, CONTAINER_STARTUP_TIMEOUT_MS } from "./helpers/setup.js";

const CIRCULAR_ID = "c3c3c3c3-0001-4001-8001-000000000001";
const CLAUSE_ID = "c3c3c3c3-0002-4001-8001-000000000002";
const OBLIGATION_ID = "c3c3c3c3-0003-4001-8001-000000000003";
const CATEGORY_ID = "c3c3c3c3-0004-4001-8001-000000000004";
const REVIEW_ID = "c3c3c3c3-0005-4001-8001-000000000005";
const REVIEWER_ID = "reviewer-reuse@example.com";

function emptySlots(): AssistantSlots {
  return {
    categoryName: null,
    obligationId: null,
    circularId: null,
    titleContains: null,
    status: null,
    reviewerId: null,
    decision: null,
    dateFrom: null,
    dateTo: null
  };
}

function buildScenarioPlan(): CommitPlan {
  return {
    proposalId: "seed-assistant-audit-reuse",
    nodes: {
      circulars: [
        {
          circular_id: CIRCULAR_ID,
          title: "Assistant Audit-Reuse Test Circular",
          type: "circular",
          category: "market_intermediaries",
          date_issued: "2026-01-01",
          date_effective: "2026-01-05",
          source_hash: "0000000000000000000000000000000000000000000000000000000000000000",
          supersedes_circular_id: null,
          valid_from: "2026-01-05",
          valid_to: null
        }
      ],
      clauses: [
        {
          clause_id: CLAUSE_ID,
          circular_id: CIRCULAR_ID,
          para_ref: "1",
          text: "Placeholder clause text for the assistant-audit-reuse integration test.",
          embedding_ref: "[]",
          valid_from: "2026-01-05",
          valid_to: null
        }
      ],
      obligations: [
        {
          obligation_id: OBLIGATION_ID,
          derived_from_clause_id: CLAUSE_ID,
          category: "client_asset_protection",
          requirement_text: "Placeholder requirement text for the assistant-audit-reuse integration test.",
          trigger_event: "test_trigger",
          deadline_rule: "immediate",
          responsible_role: "Compliance Officer",
          evidence_required: "test evidence",
          penalty_ref: null,
          confidence_score: 0.9,
          grounding_score: 0.9,
          status: "committed",
          valid_from: "2026-01-05",
          valid_to: null
        }
      ],
      intermediaryCategories: [{ category_id: CATEGORY_ID, name: "Stockbroker" }],
      humanReviews: [
        {
          review_id: REVIEW_ID,
          obligation_id: OBLIGATION_ID,
          reviewer_id: REVIEWER_ID,
          tier: "B",
          decision: "approve",
          rationale: "Consistent with existing obligations — assistant-audit-reuse fixture.",
          decided_at: "2026-01-10T00:00:00Z",
          valid_from: "2026-01-10",
          valid_to: null
        }
      ]
    },
    edges: [
      { type: "PART_OF", clause_id: CLAUSE_ID, circular_id: CIRCULAR_ID },
      { type: "DERIVED_FROM", obligation_id: OBLIGATION_ID, clause_id: CLAUSE_ID },
      { type: "APPLIES_TO", obligation_id: OBLIGATION_ID, category_id: CATEGORY_ID },
      { type: "REVIEWED_BY", obligation_id: OBLIGATION_ID, review_id: REVIEW_ID }
    ]
  };
}

describe("structured-retrieval's three AuditQueryService-backed intents (integration, FR-6)", () => {
  let ctx: Neo4jTestContext;
  let auditQueryService: AuditQueryService;
  let assistantQueryService: AssistantQueryService;

  beforeAll(async () => {
    ctx = await startNeo4j();
    await migrate(ctx.driver);
    await resetGraph(ctx.driver);

    const writer = new GraphWriter(ctx.driver);
    await writer.commitProposal(buildScenarioPlan());

    auditQueryService = new AuditQueryService(ctx.driver);
    assistantQueryService = new AssistantQueryService(ctx.driver);
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    if (ctx) await stopNeo4j(ctx);
  });

  it(
    "review_history_by_obligation returns the exact same HumanReview facts as AuditQueryService.findByObligationId directly",
    async () => {
      const directRows = await auditQueryService.findByObligationId(OBLIGATION_ID);
      expect(directRows).toHaveLength(1);

      const result = await retrieveStructured(
        "review_history_by_obligation",
        { ...emptySlots(), obligationId: OBLIGATION_ID },
        { assistantQueryService, auditQueryService }
      );

      expect(result.clarification).toBeUndefined();
      expect(result.context.humanReviews).toHaveLength(1);
      const review = result.context.humanReviews[0];
      const directReview = directRows[0].review;
      expect(review.review_id).toBe(directReview.review_id);
      expect(review.decision).toBe(directReview.decision);
      expect(review.rationale).toBe(directReview.rationale);
      expect(review.decided_at).toBe(directReview.decided_at);
      expect(review.obligation_id).toBe(directReview.obligation_id);

      expect(result.context.obligations.map((o) => o.obligation_id)).toEqual([directRows[0].obligation.obligation_id]);
    },
    CONTAINER_STARTUP_TIMEOUT_MS
  );

  it(
    "review_history_by_circular returns the exact same HumanReview facts as AuditQueryService.search({ circularId }) directly",
    async () => {
      const directResponse = await auditQueryService.search({ circularId: CIRCULAR_ID });
      expect(directResponse.rows).toHaveLength(1);

      const result = await retrieveStructured(
        "review_history_by_circular",
        { ...emptySlots(), circularId: CIRCULAR_ID },
        { assistantQueryService, auditQueryService }
      );

      expect(result.context.humanReviews.map((r) => r.review_id)).toEqual([directResponse.rows[0].review.review_id]);
      expect(result.context.humanReviews[0].decision).toBe(directResponse.rows[0].review.decision);
    },
    CONTAINER_STARTUP_TIMEOUT_MS
  );

  it(
    "review_history_by_reviewer returns the exact same HumanReview facts as AuditQueryService.search({ reviewerId }) directly",
    async () => {
      const directResponse = await auditQueryService.search({ reviewerId: REVIEWER_ID });
      expect(directResponse.rows).toHaveLength(1);

      const result = await retrieveStructured(
        "review_history_by_reviewer",
        { ...emptySlots(), reviewerId: REVIEWER_ID },
        { assistantQueryService, auditQueryService }
      );

      expect(result.context.humanReviews.map((r) => r.review_id)).toEqual([directResponse.rows[0].review.review_id]);
      expect(result.context.humanReviews[0].reviewer_id).toBe(REVIEWER_ID);
    },
    CONTAINER_STARTUP_TIMEOUT_MS
  );
});
