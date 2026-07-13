// Deterministic confidence-score post-processing (Spec 03 §6.1–§6.3,
// FR-10). `confidence_score` is never the raw `model_self_reported`
// value the LLM emits — it's this pure function's output, so given the
// same inputs it always returns the same score: no second model call, no
// randomness. This reproducibility matters for downstream Tier A/B/C
// routing stability (Spec 00 §3 / Spec 05).
import type { ConfidenceBreakdown } from "./obligation-extraction.types.js";

const COMPLETENESS_PENALTY_CAP = 0.35;
const AMBIGUITY_PENALTY_CAP = 0.25;
const GRAPHRAG_BONUS_CAP = 0.15;

const UNSPECIFIED_SENTINEL = "unspecified — see clause";

// §6.2: simple keyword heuristic, not a re-interpretation of the clause.
const PENALTY_LANGUAGE_KEYWORDS = ["penalty", "fine", "action under section", "sebi act"];

// §6.3: hedging lexicon, matched as a heuristic string check, not a
// second model call.
const HEDGING_LEXICON = ["may", "appears to", "unclear whether", "possibly", "if applicable"];

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export interface CompletenessPenaltyInput {
  responsible_role: string;
  evidence_required: string;
  penalty_ref: string | null;
  applies_to_category_names: string[];
  applies_to_unknown_category_names: string[];
  /** The source clause's raw text — used only for the §6.2 penalty-
   *  language keyword heuristic, never re-interpreted beyond that. */
  clauseText: string;
}

/** §6.2. `deadline_rule === "NONE"` is intentionally NOT a parameter here
 *  — it is never penalized (a clause genuinely stating no deadline is a
 *  correct, complete extraction, not a gap; penalizing it would create a
 *  perverse incentive to fabricate a deadline, contradicting FR-8). */
export function computeCompletenessPenalty(input: CompletenessPenaltyInput): number {
  let penalty = 0;

  if (input.responsible_role === UNSPECIFIED_SENTINEL) {
    penalty += 0.1;
  }
  if (input.evidence_required === UNSPECIFIED_SENTINEL) {
    penalty += 0.1;
  }
  if (input.penalty_ref === null && clauseTextSuggestsPenalty(input.clauseText)) {
    penalty += 0.15;
  }
  // Zero known-category matches: every proposed category name landed in
  // the unknown bucket.
  if (input.applies_to_category_names.length === 0 && input.applies_to_unknown_category_names.length > 0) {
    penalty += 0.1;
  }

  return Math.min(penalty, COMPLETENESS_PENALTY_CAP);
}

function clauseTextSuggestsPenalty(clauseText: string): boolean {
  const lower = clauseText.toLowerCase();
  return PENALTY_LANGUAGE_KEYWORDS.some((keyword) => lower.includes(keyword));
}

export interface AmbiguityPenaltyInput {
  requirement_text: string;
  applies_to_unknown_category_names: string[];
}

export function computeAmbiguityPenalty(input: AmbiguityPenaltyInput): number {
  let penalty = 0;

  if (containsHedgingLanguage(input.requirement_text)) {
    penalty += 0.1;
  }
  if (input.applies_to_unknown_category_names.length > 0) {
    penalty += 0.15;
  }

  return Math.min(penalty, AMBIGUITY_PENALTY_CAP);
}

function containsHedgingLanguage(text: string): boolean {
  const lower = text.toLowerCase();
  return HEDGING_LEXICON.some((phrase) => new RegExp(`\\b${escapeRegExp(phrase)}\\b`).test(lower));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface GraphRagBonusInput {
  is_first_seen_obligation_type: boolean;
  topSimilarity: number;
}

/** §6.3: rewards grounded consistency with prior, already-processed
 *  material. A first-seen obligation type must NEVER receive a bonus for
 *  novelty — novelty is exactly what routes it to Tier B for human review
 *  (Spec 00 §3), so this function must never let
 *  `is_first_seen_obligation_type: true` push the score up. */
export function computeGraphRagBonus(input: GraphRagBonusInput): number {
  if (input.is_first_seen_obligation_type) {
    return 0;
  }
  if (input.topSimilarity >= 0.9) {
    return Math.min(0.15, GRAPHRAG_BONUS_CAP);
  }
  if (input.topSimilarity >= 0.75) {
    return Math.min(0.08, GRAPHRAG_BONUS_CAP);
  }
  return 0;
}

export interface ConfidenceScoreProposalInput {
  requirement_text: string;
  deadline_rule: string;
  responsible_role: string;
  evidence_required: string;
  penalty_ref: string | null;
  applies_to_category_names: string[];
  applies_to_unknown_category_names: string[];
  /** Source clause text, used only for the completeness-penalty keyword
   *  heuristic (§6.2). */
  clauseText: string;
}

export interface ConfidenceScoreGraphRagInput {
  is_first_seen_obligation_type: boolean;
  topSimilarity: number;
}

/** Spec 03 §6.1, normative. Pure and independently unit-testable — no
 *  I/O, no randomness. */
export function computeConfidenceScore(
  proposal: ConfidenceScoreProposalInput,
  modelSelfReported: number,
  graphrag: ConfidenceScoreGraphRagInput
): ConfidenceBreakdown {
  const field_completeness_penalty = computeCompletenessPenalty(proposal);
  const ambiguity_penalty = computeAmbiguityPenalty(proposal);
  const graphrag_support_bonus = computeGraphRagBonus(graphrag);

  const final = clamp01(modelSelfReported - field_completeness_penalty - ambiguity_penalty + graphrag_support_bonus);

  return {
    model_self_reported: modelSelfReported,
    field_completeness_penalty,
    ambiguity_penalty,
    graphrag_support_bonus,
    final
  };
}
