// Deterministic grounding-score post-processing (Spec 04 §6, FR-4–FR-8).
// `grounding_score` is never a single opaque LLM-generated number — these
// pure functions turn the model's per-field `case` classification into a
// principled, explainable aggregate. Given the same field classifications,
// aggregateGroundingScore() always returns the same score: no second
// model call, no randomness. Mirrors confidence-score.ts's role in Spec 03
// (deterministic post-processing kept separate from the LLM call itself,
// per Spec 04 §11 task 5).
import type { CheckableField, FieldGroundingResult } from "./grounding-verification.types.js";

/** FR-2.2's four faithfulness cases, plus FR-4's fifth "legitimately
 *  absent" case (a field correctly left empty on both clause and
 *  proposal — not a gap, not penalized). */
export const FIELD_CASES = ["directly_stated", "paraphrase", "dropped_condition", "fabricated", "legitimately_absent"] as const;

export type FieldCase = (typeof FIELD_CASES)[number];

// FR-6: PLACEHOLDER thresholds — round numbers, not derived from a
// labeled dataset (Spec 04 §13). Grep-able for calibration follow-up.
export const VERDICT_PASS_THRESHOLD = 0.75; // PLACEHOLDER
export const VERDICT_BORDERLINE_THRESHOLD = 0.5; // PLACEHOLDER

// FR-7 / FR-8 caps.
const FABRICATED_SCORE_CAP = 0.4;
const DROPPED_CONDITION_SCORE_CAP = 0.6;

/** FR-4 rubric, table-driven and exhaustive over FIELD_CASES. Pure — no
 *  I/O, no randomness. This is the model's per-field `case` judgment
 *  turned into a score; the model is never asked to emit `.score`
 *  directly (mirrors Spec 03's confidence_score convention of not
 *  trusting a bare LLM-guessed float). */
export function scoreField(fieldCase: FieldCase): number {
  switch (fieldCase) {
    case "directly_stated":
      return 1.0;
    case "paraphrase":
      return 0.85;
    case "dropped_condition":
      return 0.4;
    case "fabricated":
      return 0.0;
    case "legitimately_absent":
      // Not penalized — a field correctly left empty is faithful, not a
      // gap (FR-4's rubric table, last row).
      return 1.0;
    default: {
      // Exhaustiveness guard — TypeScript already enforces this via the
      // FieldCase union, but this keeps the function safe if the Zod
      // schema's enum and this union ever drift apart.
      const _exhaustive: never = fieldCase;
      throw new Error(`scoreField: unhandled field case "${String(_exhaustive)}"`);
    }
  }
}

export interface RawFieldAssessment {
  field: CheckableField;
  case: FieldCase;
  supporting_spans: string[];
  rationale: string;
}

/** Turns a model-emitted per-field assessment into the output contract's
 *  FieldGroundingResult (§4) — computes `.score`, `.fabricated`, and
 *  `.dropped_condition` from `.case` via scoreField(), rather than
 *  trusting the model to self-report those booleans consistently with
 *  its own case classification. */
export function buildFieldGroundingResult(raw: RawFieldAssessment): FieldGroundingResult {
  return {
    field: raw.field,
    score: scoreField(raw.case),
    fabricated: raw.case === "fabricated",
    dropped_condition: raw.case === "dropped_condition",
    supporting_spans: raw.supporting_spans,
    rationale: raw.rationale
  };
}

/** FR-5/FR-7/FR-8. Unweighted mean across all field_results (v1 default,
 *  flagged as a placeholder pending compliance sign-off on any weighting
 *  scheme — Spec 04 §13), then capped:
 *  - FR-8: any `dropped_condition` field caps the aggregate at 0.6.
 *  - FR-7: any `fabricated` field caps the aggregate at 0.4 — this is the
 *    STRICTER of the two caps, so when both a fabricated and a
 *    dropped-condition field are present in the same result, the
 *    fabricated cap (0.4) wins over the dropped-condition cap (0.6),
 *    since Math.min() naturally selects the lower value regardless of
 *    application order (Spec 04 §10's "cap-precedence" unit test).
 *
 *  Structured (per Spec 04 §13's "Grounding score weighting" open
 *  question) so a `Record<CheckableField, number>` weight map — defaulting
 *  to all-1.0 — could be dropped in later without an interface change;
 *  not implemented in v1 per the recommended default (simplicity,
 *  explainability, no compliance sign-off yet on any weighting scheme). */
export function aggregateGroundingScore(fieldResults: FieldGroundingResult[]): number {
  if (fieldResults.length === 0) {
    // Defensive — the schema requires exactly the six checkable fields,
    // so this should be unreachable in practice, but a mean over zero
    // values is undefined and must not silently become NaN downstream.
    return 0;
  }

  const rawMean = fieldResults.reduce((sum, f) => sum + f.score, 0) / fieldResults.length;

  let capped = rawMean;
  if (fieldResults.some((f) => f.dropped_condition)) {
    capped = Math.min(capped, DROPPED_CONDITION_SCORE_CAP);
  }
  if (fieldResults.some((f) => f.fabricated)) {
    capped = Math.min(capped, FABRICATED_SCORE_CAP);
  }
  return capped;
}

/** FR-6. PLACEHOLDER thresholds, boundary-exact per Spec 04 §10's test
 *  plan (0.75 exactly -> "pass", 0.4999 -> "fail"). Because
 *  aggregateGroundingScore() already applies the FR-7/FR-8 caps before
 *  this function ever sees the score, FR-7's "verdict MUST be fail" and
 *  FR-8's "verdict MUST be at most borderline" requirements fall out of
 *  these plain threshold comparisons automatically (0.4 < 0.5 -> fail;
 *  0.6 is in [0.5, 0.75) -> borderline) — no separate fabricated/
 *  dropped-condition branching is needed here. */
export function classifyVerdict(groundingScore: number): "pass" | "borderline" | "fail" {
  if (groundingScore >= VERDICT_PASS_THRESHOLD) {
    return "pass";
  }
  if (groundingScore >= VERDICT_BORDERLINE_THRESHOLD) {
    return "borderline";
  }
  return "fail";
}
