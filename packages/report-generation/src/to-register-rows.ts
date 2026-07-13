// Spec 10 §5.1/§5.6 — flattens AuditQueryService.findRegisterAsOf's
// per-Obligation shape (RegisterQueryRow, one node per Obligation with its
// ProcessTasks/HumanReviews collected onto it) into ComplianceRegisterRow[],
// the flat one-row-per-fact shape the XLSX sheet (and any future PDF
// listing) consumes directly (§4.2).
//
// Both types are imported from @sentinel-act/graph-db's public entry point
// (packages/graph-db/src/index.ts), not from
// packages/graph-db/src/queries/audit-query.types.ts directly — that
// re-export was added as part of this task (it did not exist yet; the
// export list there has been additive-only across specs per that file's
// own top-of-file comment, and this addition does not collide with
// anything already exported).
import type { ComplianceRegisterRow, RegisterQueryRow } from "@sentinel-act/graph-db";
import type { HumanReview } from "@sentinel-act/graph-schema";

// ---------------------------------------------------------------------------
// FR-14 / FR-15 row-shaping decision — read this before changing the loop
// below.
//
// ComplianceRegisterRow's own doc comment (audit-query.types.ts) says:
// "One row per HumanReview, OR one synthetic row per Tier-A Obligation
// with review fields null (see FR-14)." Separately, FR-15 says: "If an
// Obligation maps to more than one ProcessTask ... the register MUST
// repeat the Obligation's and HumanReview's columns once per ProcessTask
// ... a normalized flat row per (Obligation, ProcessTask, HumanReview)
// triple."
//
// Taken literally, FR-15's "(Obligation, ProcessTask, HumanReview) triple"
// phrasing describes a full cross product of tasks x reviews for a given
// Obligation. The spec's own §10 Test Plan gives exactly three concrete
// cases, none of which actually exercises a >1-task AND >1-review
// Obligation simultaneously:
//
//   1. A Tier A obligation (0 reviews) -> exactly 1 ComplianceRegisterRow
//      (the FR-14 synthetic row).
//   2. An obligation mapped to 2 ProcessTasks -> 2 rows, obligation columns
//      repeated (implicitly: with a single review-or-no-review state).
//   3. An obligation with 2 HumanReviews (Tier C) and 1 ProcessTask -> 2
//      rows, one per review.
//
// This implementation takes FR-15's phrasing at face value and produces
// the FULL cross product of "task entries" x "review entries" for each
// Obligation. All three test-plan cases above fall out of that rule
// directly (1x1=1, 2x1=2, 1x2=2). The one case the spec does not exercise
// or discuss — an Obligation with BOTH >1 ProcessTask AND >1 HumanReview
// (e.g. 2 tasks x 2 Tier C maker+checker reviews) — would, under this
// literal reading, produce a full 2x2=4-row cross product, even though the
// maker/checker review pair is a decision about the Obligation as a whole,
// not about any one task. That is a real oddity (a reader skimming the
// sheet could misread "4 rows" as "4 independent facts" when it is really
// 2 tasks each duplicated across the same 2 reviews), but no simplification
// short of this literal cross product satisfies all three stated test
// cases at once, and the spec gives no explicit alternative for that
// specific combination. Flagged here explicitly so a future reader does
// not "fix" this into a zip-by-index (which would silently drop rows and
// fail test case 2/3 as soon as both task count and review count exceed 1
// with different lengths) without re-deriving this same analysis.
//
// A second, smaller judgment call: what to do with an Obligation that has
// ZERO reviews but is NOT Tier A (e.g. a Tier B/C Obligation still
// pending, or a Tier C/ESCALATE Obligation whose sole maker review was
// excluded from `reviews` by AuditQueryService's FR-11a guard). FR-14 only
// prescribes the synthetic-row behavior for Tier A. This implementation
// still emits a row for such an Obligation (dropping it silently would
// violate the register's "list everything valid as of this date" purpose
// — see spec §4.2/FR-14's own rationale), but leaves EVERY review column
// (`review_id`, `reviewer_id`, `review_tier`, `decision`, `rationale`,
// `decided_at`) as `null` rather than stamping `decision: "auto-committed"`
// — that literal string is reserved for genuine Tier A rows (identified by
// `Obligation.status === "tier_a_committed"`, the one unambiguous signal
// available on this shape; ReviewTier is not a field on Obligation itself).
// ---------------------------------------------------------------------------

const TIER_A_COMMITTED_STATUS = "tier_a_committed";

/** One task "slot" to cross-join against reviews: either a real ProcessTask
 *  or the null placeholder used when an Obligation has zero mapped tasks
 *  (so the Obligation itself still produces at least one register row). */
type TaskSlot = RegisterQueryRow["tasks"][number] | null;

/** One review "slot" to cross-join against tasks: either a real
 *  HumanReview or the null placeholder used for a Tier A / not-yet-reviewed
 *  Obligation (see the block comment above). */
type ReviewSlot = HumanReview | null;

function taskSlots(row: RegisterQueryRow): TaskSlot[] {
  return row.tasks.length > 0 ? row.tasks : [null];
}

function reviewSlots(row: RegisterQueryRow): ReviewSlot[] {
  return row.reviews.length > 0 ? row.reviews : [null];
}

function buildRow(row: RegisterQueryRow, task: TaskSlot, review: ReviewSlot): ComplianceRegisterRow {
  const { obligation, clause, circular } = row;
  const isTierA = review === null && obligation.status === TIER_A_COMMITTED_STATUS;

  return {
    // Circular
    circular_id: circular?.circular_id ?? null,
    circular_title: circular?.title ?? null,
    circular_date_issued: circular?.date_issued ?? null,
    circular_date_effective: circular?.date_effective ?? null,
    // Clause
    clause_para_ref: clause?.para_ref ?? null,
    // Obligation
    obligation_id: obligation.obligation_id,
    obligation_category: obligation.category,
    requirement_text: obligation.requirement_text,
    deadline_rule: obligation.deadline_rule,
    responsible_role: obligation.responsible_role,
    penalty_ref: obligation.penalty_ref,
    obligation_status: obligation.status,
    confidence_score: obligation.confidence_score,
    grounding_score: obligation.grounding_score,
    // ProcessTask (FR-15: repeated per task)
    task_id: task?.task_id ?? null,
    task_name: task?.task_name ?? null,
    owner_role: task?.owner_role ?? null,
    sla_hours: task?.sla_hours ?? null,
    system_touchpoint: task?.system_touchpoint ?? null,
    risk_score: task?.risk_score ?? null,
    // HumanReview (FR-14: null/"auto-committed" for a genuine Tier A row;
    // also null — but NOT "auto-committed" — for a non-Tier-A Obligation
    // with no visible review yet, see block comment above)
    review_id: review?.review_id ?? null,
    reviewer_id: review?.reviewer_id ?? null,
    review_tier: review ? review.tier : isTierA ? "A" : null,
    decision: review ? review.decision : isTierA ? "auto-committed" : null,
    rationale: review?.rationale ?? null,
    decided_at: review?.decided_at ?? null
  };
}

/** Flattens AuditQueryService.findRegisterAsOf's raw per-Obligation rows
 *  into the flat ComplianceRegisterRow[] shape §4.2/FR-14/FR-15 describe.
 *  Pure function — no I/O, no Neo4j, safe to unit test in isolation
 *  (Spec 10 §5.6). See the block comment above for the exact cross-product
 *  rule and the two judgment calls this implementation makes where the
 *  spec text is ambiguous or silent. */
export function toRegisterRows(rows: RegisterQueryRow[]): ComplianceRegisterRow[] {
  const result: ComplianceRegisterRow[] = [];
  for (const row of rows) {
    for (const task of taskSlots(row)) {
      for (const review of reviewSlots(row)) {
        result.push(buildRow(row, task, review));
      }
    }
  }
  return result;
}
