// Type contracts for the Grounding and Verification Agent (Spec 04 §4).
// Colocated in a sibling `.types.ts` (mirrors obligation-extraction.types.ts's
// split, Spec 03 §11 task 1) so grounding-scoring.ts and
// contradiction-lookup.tool.ts can import without pulling in the Mastra
// Agent/LLM wiring.
//
// No field on `Obligation`/`Clause`/`Circular` is redefined here.
// `ProposedObligation` mirrors Obligation's writable fields minus the
// graph-assigned ones (obligation_id, the bitemporal triple, status,
// grounding_score), which the Orchestrator assigns at commit time, after
// this agent has already run (Spec 04 §4).
import type { Obligation, Clause, Circular } from "@sentinel-act/graph-schema";

/**
 * The shape handed to this agent by the Orchestrator after Obligation
 * Extraction (Spec 03) returns.
 *
 * Post-review correction (Spec 04 §4): was `applies_to_category_ids:
 * string[]`. Spec 03's actual output field at this pipeline stage is
 * `applies_to_category_names` (category *names* resolved to
 * `IntermediaryCategory.category_id` only later, at Orchestrator commit
 * time) — this agent does not read or validate this field (category
 * mapping correctness is Spec 05's concern), so it is passed through
 * unexamined.
 */
export interface ProposedObligation {
  category: Obligation["category"];
  requirement_text: Obligation["requirement_text"];
  trigger_event: Obligation["trigger_event"];
  deadline_rule: Obligation["deadline_rule"];
  responsible_role: Obligation["responsible_role"];
  evidence_required: Obligation["evidence_required"];
  penalty_ref: Obligation["penalty_ref"];
  /** Set by Extraction, passed through unchanged. Deliberately NEVER
   *  surfaced inside this agent's own prompt (FR-3) — it must not anchor
   *  the verification pass's independent judgment. */
  confidence_score: Obligation["confidence_score"];
  derived_from_clause_id: Obligation["derived_from_clause_id"];
  applies_to_category_names: string[];
}

/** The literal source text this Obligation must be checked against. */
export interface SourceClauseContext {
  clause: Pick<Clause, "clause_id" | "para_ref" | "text">;
  circular: Pick<Circular, "circular_id" | "title" | "date_effective">;
}

/** Input to the agent's single verification call. */
export interface GroundingVerificationInput {
  proposed: ProposedObligation;
  source: SourceClauseContext;
  /** Correlation id for tracing this run through the Orchestrator/audit ledger. */
  run_id: string;
}

/** The six checkable fields (FR-2.2). */
export const CHECKABLE_FIELDS = [
  "requirement_text",
  "trigger_event",
  "deadline_rule",
  "responsible_role",
  "evidence_required",
  "penalty_ref"
] as const;

export type CheckableField = (typeof CHECKABLE_FIELDS)[number];

/** One scored field in the faithfulness check. See grounding-scoring.ts
 *  for the FR-4 rubric that turns a `FieldCase` into `.score`. */
export interface FieldGroundingResult {
  field: CheckableField;
  /** 0..1, computed by scoreField() from the model's `case`
   *  classification — never a raw model-emitted float (mirrors Spec 03's
   *  confidence_score convention of never trusting a bare LLM guess). */
  score: number;
  /** true iff this field is fabricated / not present in Clause.text at all. */
  fabricated: boolean;
  /** true iff the field drops a qualifier/condition present in Clause.text. */
  dropped_condition: boolean;
  /** The literal span(s) of Clause.text the field is grounded in, or [] if none found. */
  supporting_spans: string[];
  /** One-sentence rationale, always populated (used for the console's grounding breakdown). */
  rationale: string;
}

/** The Obligation fields a live contradiction candidate can genuinely
 *  diverge on. Post-review correction (Spec 04 §4): "responsible_role"
 *  was removed from this union — contradictionLookupTool's Cypher
 *  exact-matches on responsible_role, so a returned candidate can never
 *  diverge from the proposal on that field by construction. */
export type DivergentField = "deadline_rule" | "requirement_text" | "penalty_ref";

/** A single detected conflict against a live Obligation. */
export interface ContradictionDetail {
  conflicting_obligation_id: string;
  divergent_field: DivergentField;
  proposed_value: string;
  existing_value: string;
  /** Plain-language, UI-renderable explanation naming both values —
   *  feeds Journey D's side-by-side view. A generic "conflict detected"
   *  string is a spec violation (FR-12). */
  explanation: string;
}

/** The exact output contract handed back to the Orchestrator (§4). */
export interface GroundingVerificationOutput {
  run_id: string;
  /** Aggregate 0..1 — unweighted mean of field_results[].score with the
   *  FR-7/FR-8 fabrication/dropped-condition caps applied. */
  grounding_score: number;
  field_results: FieldGroundingResult[];
  contradiction: boolean;
  /** Populated iff contradiction is true; one entry per conflicting live
   *  Obligation found (FR-11 invariant, enforced in code). */
  contradiction_details: ContradictionDetail[];
  /** PLACEHOLDER thresholds (FR-6): >=0.75 pass, [0.5,0.75) borderline,
   *  <0.5 fail — unvalidated against a labeled dataset, see Spec 04 §13. */
  verdict: "pass" | "borderline" | "fail";
  /** Free-text summary for audit-ledger logging and reviewer context. */
  summary: string;
  /** Wall-clock ms the verification call took. */
  duration_ms: number;
}
