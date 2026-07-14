// structured-retrieval.test.ts (Spec 12 §10): correctly dispatches each of
// the eight structured intents to either AssistantQueryService.runTemplate
// or the correct AuditQueryService method (FR-6); missing/invalid required
// slots produce a clarification response, never a guess or an error
// (FR-9); the audit-row-to-context bridge enriches Obligation/ProcessTask
// lineage via T2 without letting T2's own (unfiltered) HumanReview rows
// leak into the caller's filtered review set.
import { describe, expect, it, vi } from "vitest";
import { ValidationError } from "@sentinel-act/graph-db";
import type { AssistantGraphContext, AuditTrailRow } from "@sentinel-act/graph-db";
import { retrieveStructured, type StructuredRetrievalDeps } from "../src/structured-retrieval.js";
import type { AssistantSlots } from "../src/types.js";

function emptySlots(overrides: Partial<AssistantSlots> = {}): AssistantSlots {
  return {
    categoryName: null,
    obligationId: null,
    circularId: null,
    titleContains: null,
    status: null,
    reviewerId: null,
    decision: null,
    dateFrom: null,
    dateTo: null,
    ...overrides
  };
}

function emptyContext(): AssistantGraphContext {
  return { circulars: [], clauses: [], obligations: [], processTasks: [], humanReviews: [] };
}

function buildDeps(overrides: Partial<StructuredRetrievalDeps> = {}): {
  deps: StructuredRetrievalDeps;
  runTemplate: ReturnType<typeof vi.fn>;
  findByObligationId: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
} {
  const defaultRunTemplate = vi.fn(async () => emptyContext());
  const defaultFindByObligationId = vi.fn(async (): Promise<AuditTrailRow[]> => []);
  const defaultSearch = vi.fn(async () => ({ rows: [] as AuditTrailRow[], totalCount: 0, page: 1, pageSize: 50 }));

  const assistantQueryService = { runTemplate: defaultRunTemplate, ...(overrides.assistantQueryService as object) };
  const auditQueryService = {
    findByObligationId: defaultFindByObligationId,
    search: defaultSearch,
    ...(overrides.auditQueryService as object)
  };

  const deps: StructuredRetrievalDeps = { assistantQueryService, auditQueryService };
  return {
    deps,
    runTemplate: assistantQueryService.runTemplate as ReturnType<typeof vi.fn>,
    findByObligationId: auditQueryService.findByObligationId as ReturnType<typeof vi.fn>,
    search: auditQueryService.search as ReturnType<typeof vi.fn>
  };
}

describe("retrieveStructured — template-backed intents", () => {
  it("obligations_by_category_and_date_range: dispatches to the matching template with the right params", async () => {
    const { deps, runTemplate } = buildDeps();
    const slots = emptySlots({ categoryName: "Stockbroker", dateFrom: "2026-06-01", dateTo: "2026-07-31" });

    await retrieveStructured("obligations_by_category_and_date_range", slots, deps);

    expect(runTemplate).toHaveBeenCalledWith("obligations_by_category_and_date_range", {
      categoryName: "Stockbroker",
      dateFrom: "2026-06-01",
      dateTo: "2026-07-31"
    });
  });

  it("obligations_by_category_and_date_range: missing categoryName returns a clarification, never calling runTemplate", async () => {
    const { deps, runTemplate } = buildDeps();
    const slots = emptySlots({ dateFrom: "2026-06-01", dateTo: "2026-07-31" });

    const result = await retrieveStructured("obligations_by_category_and_date_range", slots, deps);

    expect(runTemplate).not.toHaveBeenCalled();
    expect(result.clarification?.missingSlots).toEqual(["categoryName"]);
    expect(result.clarification?.prompt).toContain("intermediary category");
  });

  it("obligation_by_id_with_lineage: dispatches with obligationId", async () => {
    const { deps, runTemplate } = buildDeps();
    const slots = emptySlots({ obligationId: "3fa85f64-5717-4562-b3fc-2c963f66afa6" });

    await retrieveStructured("obligation_by_id_with_lineage", slots, deps);

    expect(runTemplate).toHaveBeenCalledWith("obligation_by_id_with_lineage", {
      obligationId: "3fa85f64-5717-4562-b3fc-2c963f66afa6"
    });
  });

  it("obligation_by_id_with_lineage: a schema-invalid obligationId (e.g. not a UUID) becomes a clarification, not an error", async () => {
    const { deps } = buildDeps({
      assistantQueryService: {
        runTemplate: vi.fn(async () => {
          throw new ValidationError("obligationId must be a UUID");
        })
      }
    });
    const slots = emptySlots({ obligationId: "not-a-uuid" });

    const result = await retrieveStructured("obligation_by_id_with_lineage", slots, deps);

    expect(result.clarification?.missingSlots).toEqual(["obligationId"]);
  });

  it("circular_by_id_or_title: requires at least one of circularId/titleContains", async () => {
    const { deps, runTemplate } = buildDeps();

    const result = await retrieveStructured("circular_by_id_or_title", emptySlots(), deps);

    expect(runTemplate).not.toHaveBeenCalled();
    expect(result.clarification?.missingSlots).toEqual(["circularId", "titleContains"]);
  });

  it("circular_by_id_or_title: titleContains alone is sufficient", async () => {
    const { deps, runTemplate } = buildDeps();
    const slots = emptySlots({ titleContains: "CUSPA" });

    await retrieveStructured("circular_by_id_or_title", slots, deps);

    expect(runTemplate).toHaveBeenCalledWith("circular_by_id_or_title", { circularId: null, titleContains: "CUSPA" });
  });

  it("obligations_by_status: dispatches with status", async () => {
    const { deps, runTemplate } = buildDeps();
    const slots = emptySlots({ status: "tier_c_review" });

    await retrieveStructured("obligations_by_status", slots, deps);

    expect(runTemplate).toHaveBeenCalledWith("obligations_by_status", { status: "tier_c_review" });
  });

  it("reviews_by_category_and_date_range: dispatches with categoryName/dateFrom/dateTo/decision", async () => {
    const { deps, runTemplate } = buildDeps();
    const slots = emptySlots({
      categoryName: "Stockbroker",
      dateFrom: "2026-06-01T00:00:00Z",
      dateTo: "2026-07-31T23:59:59Z",
      decision: "approve"
    });

    await retrieveStructured("reviews_by_category_and_date_range", slots, deps);

    expect(runTemplate).toHaveBeenCalledWith("reviews_by_category_and_date_range", {
      categoryName: "Stockbroker",
      dateFrom: "2026-06-01T00:00:00Z",
      dateTo: "2026-07-31T23:59:59Z",
      decision: "approve"
    });
  });
});

function auditRow(overrides: Partial<AuditTrailRow> = {}): AuditTrailRow {
  return {
    review: {
      review_id: "rev-1",
      obligation_id: "ob-1",
      reviewer_id: "reviewer-1",
      tier: "B",
      decision: "approve",
      rationale: "Consistent with custody rules.",
      decided_at: "2026-02-05T00:00:00Z",
      valid_from: "2026-02-05",
      valid_to: null,
      recorded_at: "2026-02-05T00:00:00Z"
    },
    obligation: {
      obligation_id: "ob-1",
      category: "custody",
      requirement_text: "Do not pledge client securities.",
      status: "committed",
      confidence_score: 0.95,
      grounding_score: 0.9,
      penalty_ref: null
    },
    clause: { clause_id: "cl-46", para_ref: "46" },
    circular: { circular_id: "cir-1", title: "CUSPA Master Circular", date_issued: "2026-01-01", date_effective: "2026-02-01" },
    processTasks: [{ task_id: "task-1", task_name: "Reconcile ledger", risk_score: 0.4 }],
    ...overrides
  };
}

describe("retrieveStructured — AuditQueryService-backed intents (FR-6)", () => {
  it("review_history_by_obligation: calls findByObligationId, not a new Cypher path", async () => {
    const { deps, findByObligationId } = buildDeps({
      auditQueryService: {
        findByObligationId: vi.fn(async () => [auditRow()]),
        search: vi.fn()
      }
    });

    const result = await retrieveStructured("review_history_by_obligation", emptySlots({ obligationId: "ob-1" }), deps);

    expect(findByObligationId).toHaveBeenCalledWith("ob-1");
    expect(result.context.humanReviews).toHaveLength(1);
    expect(result.context.humanReviews[0].review_id).toBe("rev-1");
    expect(result.context.humanReviews[0].rationale).toBe("Consistent with custody rules.");
  });

  it("review_history_by_obligation: missing obligationId returns a clarification, never calling findByObligationId", async () => {
    const { deps, findByObligationId } = buildDeps();

    const result = await retrieveStructured("review_history_by_obligation", emptySlots(), deps);

    expect(findByObligationId).not.toHaveBeenCalled();
    expect(result.clarification?.missingSlots).toEqual(["obligationId"]);
  });

  it("review_history_by_circular: calls search({ circularId })", async () => {
    const { deps, search } = buildDeps({
      auditQueryService: {
        findByObligationId: vi.fn(),
        search: vi.fn(async () => ({ rows: [auditRow()], totalCount: 1, page: 1, pageSize: 50 }))
      }
    });

    await retrieveStructured("review_history_by_circular", emptySlots({ circularId: "cir-1" }), deps);

    expect(search).toHaveBeenCalledWith({ circularId: "cir-1" });
  });

  it("review_history_by_reviewer: calls search({ reviewerId, decidedFrom, decidedTo, decision })", async () => {
    const { deps, search } = buildDeps({
      auditQueryService: {
        findByObligationId: vi.fn(),
        search: vi.fn(async () => ({ rows: [], totalCount: 0, page: 1, pageSize: 50 }))
      }
    });
    const slots = emptySlots({
      reviewerId: "reviewer-1",
      dateFrom: "2026-06-01",
      dateTo: "2026-07-31",
      decision: "reject"
    });

    await retrieveStructured("review_history_by_reviewer", slots, deps);

    expect(search).toHaveBeenCalledWith({
      reviewerId: "reviewer-1",
      decidedFrom: "2026-06-01",
      decidedTo: "2026-07-31",
      decision: "reject"
    });
  });

  it("review_history_by_reviewer: missing reviewerId returns a clarification", async () => {
    const { deps, search } = buildDeps();

    const result = await retrieveStructured("review_history_by_reviewer", emptySlots(), deps);

    expect(search).not.toHaveBeenCalled();
    expect(result.clarification?.missingSlots).toEqual(["reviewerId"]);
  });

  it("enriches Obligation/ProcessTask lineage via T2 without letting T2's own HumanReview rows leak in", async () => {
    const enrichedObligationContext: AssistantGraphContext = {
      circulars: [{ circular_id: "cir-1", title: "CUSPA Master Circular", date_issued: "2026-01-01", date_effective: "2026-02-01" }],
      clauses: [{ clause_id: "cl-46", para_ref: "46", text: "Client securities must not be pledged.", circular_id: "cir-1" }],
      obligations: [
        {
          obligation_id: "ob-1",
          category: "custody",
          requirement_text: "Do not pledge client securities.",
          trigger_event: "receipt of client securities",
          deadline_rule: "immediate",
          responsible_role: "custodian",
          penalty_ref: null,
          status: "committed",
          confidence_score: 0.95,
          grounding_score: 0.9,
          derived_from_clause_id: "cl-46"
        }
      ],
      processTasks: [
        { task_id: "task-1", task_name: "Reconcile ledger", owner_role: "custodian-ops", sla_hours: 24, risk_score: 0.4, obligation_id: "ob-1" }
      ],
      // A second, unrelated review for the same obligation that T2's own
      // (unfiltered) query would return — this must NOT leak into the
      // final context, which should only ever contain the review the
      // caller's audit query actually returned.
      humanReviews: [
        {
          review_id: "rev-OTHER",
          reviewer_id: "someone-else",
          tier: "B",
          decision: "reject",
          rationale: "unrelated",
          decided_at: "2026-01-01T00:00:00Z",
          obligation_id: "ob-1"
        }
      ]
    };

    const { deps } = buildDeps({
      assistantQueryService: { runTemplate: vi.fn(async () => enrichedObligationContext) },
      auditQueryService: {
        findByObligationId: vi.fn(async () => [auditRow()]),
        search: vi.fn()
      }
    });

    const result = await retrieveStructured("review_history_by_obligation", emptySlots({ obligationId: "ob-1" }), deps);

    // Obligation lineage enriched with full fields (not blank placeholders).
    expect(result.context.obligations[0].trigger_event).toBe("receipt of client securities");
    expect(result.context.obligations[0].responsible_role).toBe("custodian");
    expect(result.context.processTasks[0].owner_role).toBe("custodian-ops");
    expect(result.context.processTasks[0].sla_hours).toBe(24);

    // HumanReview set is exactly the audit query's own result — T2's
    // unrelated review did not leak in.
    expect(result.context.humanReviews).toHaveLength(1);
    expect(result.context.humanReviews[0].review_id).toBe("rev-1");
    expect(result.context.humanReviews.some((r) => r.review_id === "rev-OTHER")).toBe(false);
  });

  it("falls back to blank-but-honest lineage fields when T2 enrichment fails (best-effort, not fatal)", async () => {
    const { deps } = buildDeps({
      assistantQueryService: {
        runTemplate: vi.fn(async () => {
          throw new Error("graph unavailable");
        })
      },
      auditQueryService: {
        findByObligationId: vi.fn(async () => [auditRow()]),
        search: vi.fn()
      }
    });

    const result = await retrieveStructured("review_history_by_obligation", emptySlots({ obligationId: "ob-1" }), deps);

    expect(result.context.obligations).toHaveLength(1);
    expect(result.context.obligations[0].obligation_id).toBe("ob-1");
    expect(result.context.humanReviews).toHaveLength(1);
  });
});
