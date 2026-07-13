// Shared test fixture builders + the NFR-Security-1 deep-search helper, used
// by the BFF route-handler integration tests under app/api/console/**/*.test.ts
// (Spec 09 Task 11). Not itself a *.test.ts file — vitest's default include
// glob does not pick this up as a suite.
import type { Circular, Clause, HumanReview, Obligation, ObligationStatus, ProcessTask, ReviewDecision, ReviewTier } from "./types";

export function makeObligation(overrides: Partial<Obligation> = {}): Obligation {
  return {
    obligation_id: "obligation-1",
    derived_from_clause_id: "clause-1",
    category: "reporting",
    requirement_text: "File the quarterly report within 30 days of quarter end.",
    trigger_event: "quarter_end",
    deadline_rule: "P30D",
    responsible_role: "compliance_officer",
    evidence_required: "filed_report_pdf",
    penalty_ref: null,
    confidence_score: 0.9,
    grounding_score: 0.85,
    status: "tier_b_review" as ObligationStatus,
    valid_from: "2026-07-01",
    valid_to: null,
    recorded_at: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

export function makeProcessTask(overrides: Partial<ProcessTask> = {}): ProcessTask {
  return {
    task_id: "task-1",
    obligation_id: "obligation-1",
    task_name: "File quarterly report",
    owner_role: "compliance_officer",
    sla_hours: 24,
    system_touchpoint: "CRM",
    risk_score: 0.5,
    valid_from: "2026-07-01",
    valid_to: null,
    recorded_at: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

export function makeClause(overrides: Partial<Clause> = {}): Clause {
  return {
    clause_id: "clause-1",
    circular_id: "circular-1",
    para_ref: "3.2",
    text: "Every regulated entity shall file a quarterly report.",
    embedding_ref: "embedding-1",
    valid_from: "2026-06-01",
    valid_to: null,
    recorded_at: "2026-06-01T00:00:00.000Z",
    ...overrides
  };
}

export function makeCircular(overrides: Partial<Circular> = {}): Circular {
  return {
    circular_id: "circular-1",
    title: "SEBI Circular on Quarterly Reporting",
    type: "circular",
    category: "reporting",
    date_issued: "2026-05-01",
    date_effective: "2026-06-01",
    source_hash: "sha256-abc",
    supersedes_circular_id: null,
    valid_from: "2026-06-01",
    valid_to: null,
    recorded_at: "2026-06-01T00:00:00.000Z",
    ...overrides
  };
}

export function makeHumanReview(overrides: Partial<HumanReview> = {}): HumanReview {
  return {
    review_id: "review-1",
    obligation_id: "obligation-1",
    reviewer_id: "reviewer-maker",
    tier: "C" as ReviewTier,
    decision: "approve" as ReviewDecision,
    rationale: "Looks correct.",
    decided_at: "2026-07-13T10:00:00.000Z",
    valid_from: "2026-07-13",
    valid_to: null,
    recorded_at: "2026-07-13T10:00:00.000Z",
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// NFR-Security-1 deep-search helper.
//
// Spec 09 §3/§12: an automated integration test must read the RAW JSON
// response body (not the DOM) and assert the peer's decision fields are
// absent "at any nesting depth, in any field" until reviewGate.status starts
// with resolved_. A naive top-level check (`body.reviewGate.reveal === null`)
// would miss a bug where some OTHER part of the response accidentally
// includes a HumanReview-shaped object (e.g. a debug field, a wrongly-wired
// lineage entry, a future field added without updating this test). This
// walks the ENTIRE parsed JSON body recursively and flags any object that
// looks like a `HumanReview` — has own keys `reviewer_id` AND `decision` —
// regardless of where in the tree it appears.
// ---------------------------------------------------------------------------

/** Returns every object found anywhere in `value`'s tree that has both a
 *  `reviewer_id` and a `decision` own key — i.e. every HumanReview-shaped
 *  object, at any nesting depth, in any field. */
export function findHumanReviewShapedObjects(value: unknown, seen: Set<unknown> = new Set()): Record<string, unknown>[] {
  if (value === null || typeof value !== "object") {
    return [];
  }
  if (seen.has(value)) {
    return []; // defensive against cycles; real JSON-parsed bodies never have one
  }
  seen.add(value);

  const found: Record<string, unknown>[] = [];

  if (Array.isArray(value)) {
    for (const item of value) {
      found.push(...findHumanReviewShapedObjects(item, seen));
    }
    return found;
  }

  const obj = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(obj, "reviewer_id") && Object.prototype.hasOwnProperty.call(obj, "decision")) {
    found.push(obj);
  }
  for (const key of Object.keys(obj)) {
    found.push(...findHumanReviewShapedObjects(obj[key], seen));
  }
  return found;
}

/** `true` iff `findHumanReviewShapedObjects` finds nothing — the assertion
 *  shape the independence-guarantee tests actually want ("this response
 *  leaks nothing"), with `findHumanReviewShapedObjects` itself available
 *  separately for the positive case (asserting exactly which/how many
 *  reviews ARE present once resolved). */
export function containsHumanReviewFields(value: unknown): boolean {
  return findHumanReviewShapedObjects(value).length > 0;
}
