import { describe, expect, it } from "vitest";
import type { RegisterQueryRow } from "@sentinel-act/graph-db";
import type { HumanReview, Obligation } from "@sentinel-act/graph-schema";
import { toRegisterRows } from "../src/to-register-rows.js";

// ---------------------------------------------------------------------------
// Fixture factories. Only the fields ComplianceRegisterRow actually reads
// matter for these tests, but the full Obligation/HumanReview interfaces
// (Bitemporal + all domain fields) must still be satisfied for the types
// to compile, so these factories fill in realistic-but-arbitrary values
// for everything else.
// ---------------------------------------------------------------------------

function makeObligation(overrides: Partial<Obligation> = {}): Obligation {
  return {
    obligation_id: "OBL-1",
    derived_from_clause_id: "CLAUSE-1",
    category: "reporting",
    requirement_text: "File the quarterly report within 30 days.",
    trigger_event: "quarter_end",
    deadline_rule: "30 days from quarter end",
    responsible_role: "Compliance Officer",
    evidence_required: "filed report copy",
    penalty_ref: null,
    confidence_score: 0.9,
    grounding_score: 0.85,
    status: "committed",
    valid_from: "2026-01-01",
    valid_to: null,
    recorded_at: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function makeReview(overrides: Partial<HumanReview> = {}): HumanReview {
  return {
    review_id: "REV-1",
    obligation_id: "OBL-1",
    reviewer_id: "reviewer@example.com",
    tier: "B",
    decision: "approve",
    rationale: "Looks correct.",
    decided_at: "2026-01-05T00:00:00.000Z",
    valid_from: "2026-01-05",
    valid_to: null,
    recorded_at: "2026-01-05T00:00:00.000Z",
    ...overrides
  };
}

function makeTask(overrides: Partial<RegisterQueryRow["tasks"][number]> = {}): RegisterQueryRow["tasks"][number] {
  return {
    task_id: "TASK-1",
    task_name: "Prepare filing",
    owner_role: "Ops",
    sla_hours: 24,
    system_touchpoint: "filing-portal",
    risk_score: 0.4,
    ...overrides
  };
}

function makeRegisterRow(overrides: Partial<RegisterQueryRow> = {}): RegisterQueryRow {
  return {
    obligation: makeObligation(),
    clause: { clause_id: "CLAUSE-1", para_ref: "12" },
    circular: {
      circular_id: "CIRC-1",
      title: "Sample Circular",
      date_issued: "2025-12-01",
      date_effective: "2026-01-01"
    },
    tasks: [makeTask()],
    reviews: [makeReview()],
    ...overrides
  };
}

describe("toRegisterRows", () => {
  it("FR-14: a Tier A obligation (no HumanReview) maps to exactly one row with decision auto-committed", () => {
    const row = makeRegisterRow({
      obligation: makeObligation({ obligation_id: "OBL-TIER-A", status: "tier_a_committed" }),
      tasks: [makeTask()],
      reviews: []
    });

    const result = toRegisterRows([row]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      obligation_id: "OBL-TIER-A",
      review_id: null,
      reviewer_id: null,
      review_tier: "A",
      decision: "auto-committed",
      rationale: null,
      decided_at: null
    });
  });

  it("Acceptance Criterion 5: Tier A row has blank reviewer_id and rationale, not an omitted row", () => {
    const row = makeRegisterRow({
      obligation: makeObligation({ obligation_id: "OBL-TIER-A-2", status: "tier_a_committed" }),
      tasks: [],
      reviews: []
    });

    const result = toRegisterRows([row]);

    expect(result).toHaveLength(1);
    expect(result[0].reviewer_id).toBeNull();
    expect(result[0].rationale).toBeNull();
    expect(result[0].decision).toBe("auto-committed");
  });

  it("FR-15: an obligation mapped to 2 ProcessTasks produces 2 rows with repeated obligation columns", () => {
    const row = makeRegisterRow({
      obligation: makeObligation({ obligation_id: "OBL-2-TASKS" }),
      tasks: [makeTask({ task_id: "TASK-A" }), makeTask({ task_id: "TASK-B" })],
      reviews: [makeReview()]
    });

    const result = toRegisterRows([row]);

    expect(result).toHaveLength(2);
    expect(result.every((r) => r.obligation_id === "OBL-2-TASKS")).toBe(true);
    expect(result.map((r) => r.task_id).sort()).toEqual(["TASK-A", "TASK-B"]);
  });

  it("an obligation with 2 HumanReviews (Tier C) and 1 ProcessTask produces 2 rows, one per review", () => {
    const row = makeRegisterRow({
      obligation: makeObligation({ obligation_id: "OBL-TIER-C", status: "tier_c_review" }),
      tasks: [makeTask({ task_id: "TASK-ONLY" })],
      reviews: [
        makeReview({ review_id: "REV-MAKER", reviewer_id: "maker@example.com", tier: "C", decided_at: "2026-01-05T00:00:00.000Z" }),
        makeReview({ review_id: "REV-CHECKER", reviewer_id: "checker@example.com", tier: "C", decided_at: "2026-01-05T00:10:00.000Z" })
      ]
    });

    const result = toRegisterRows([row]);

    expect(result).toHaveLength(2);
    expect(result.every((r) => r.task_id === "TASK-ONLY")).toBe(true);
    expect(result.map((r) => r.review_id).sort()).toEqual(["REV-CHECKER", "REV-MAKER"]);
  });

  it("documents the full cross-product interpretation: 2 tasks x 2 reviews produces 4 rows", () => {
    const row = makeRegisterRow({
      obligation: makeObligation({ obligation_id: "OBL-CROSS" }),
      tasks: [makeTask({ task_id: "TASK-A" }), makeTask({ task_id: "TASK-B" })],
      reviews: [makeReview({ review_id: "REV-1" }), makeReview({ review_id: "REV-2" })]
    });

    const result = toRegisterRows([row]);

    // See to-register-rows.ts's top-of-file comment: this is the literal
    // reading of FR-15's "(Obligation, ProcessTask, HumanReview) triple"
    // phrasing, flagged there as a real oddity for this exact case.
    expect(result).toHaveLength(4);
    const pairs = result.map((r) => `${r.task_id}:${r.review_id}`).sort();
    expect(pairs).toEqual(["TASK-A:REV-1", "TASK-A:REV-2", "TASK-B:REV-1", "TASK-B:REV-2"]);
  });

  it("a non-Tier-A obligation with no visible review yet gets null review fields, not auto-committed", () => {
    const row = makeRegisterRow({
      obligation: makeObligation({ obligation_id: "OBL-PENDING", status: "tier_b_review" }),
      tasks: [makeTask()],
      reviews: []
    });

    const result = toRegisterRows([row]);

    expect(result).toHaveLength(1);
    expect(result[0].decision).toBeNull();
    expect(result[0].review_tier).toBeNull();
  });

  it("carries circular/clause lineage through onto every row, and null lineage stays null", () => {
    const withLineage = makeRegisterRow({ obligation: makeObligation({ obligation_id: "OBL-LINEAGE" }) });
    const withoutLineage = makeRegisterRow({
      obligation: makeObligation({ obligation_id: "OBL-NO-LINEAGE" }),
      clause: null,
      circular: null
    });

    const result = toRegisterRows([withLineage, withoutLineage]);

    const lineageRow = result.find((r) => r.obligation_id === "OBL-LINEAGE");
    const noLineageRow = result.find((r) => r.obligation_id === "OBL-NO-LINEAGE");

    expect(lineageRow?.circular_id).toBe("CIRC-1");
    expect(lineageRow?.clause_para_ref).toBe("12");
    expect(noLineageRow?.circular_id).toBeNull();
    expect(noLineageRow?.clause_para_ref).toBeNull();
  });

  it("returns an empty array for an empty input", () => {
    expect(toRegisterRows([])).toEqual([]);
  });
});
