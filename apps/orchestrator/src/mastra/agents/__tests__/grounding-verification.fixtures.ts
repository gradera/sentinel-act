// Checked-in fixture helpers for the Grounding and Verification Agent
// (Spec 04). Mirrors obligation-extraction.fixtures.ts's structure and
// intent — text is written to be representative of SEBI circular style,
// not copied from a real circular, except where noted (the flagship 3
// July 2026 CUSPA Paragraph 46 fixture used for the manual/integration
// Definition-of-Done check).
import type { GroundingVerificationInput, ProposedObligation, SourceClauseContext } from "../grounding-verification.types.js";
import type { ContradictionCandidate } from "../../tools/contradiction-lookup.tool.js";
import type { GroundingModelOutput } from "../grounding-verification.schema.js";

export function makeSourceContext(overrides: Partial<SourceClauseContext> = {}): SourceClauseContext {
  return {
    clause: {
      clause_id: "clause-gv-1",
      para_ref: "Para 4.2",
      text:
        "The stockbroker shall report unpaid securities beyond T+X to the exchange within 5 business days of the Board's approval of the resolution, failing which action under Section 11 of the SEBI Act, 1992 may be initiated.",
      ...overrides.clause
    },
    circular: {
      circular_id: "circ-gv-1",
      title: "Circular on Client Funds — Unpaid Securities",
      date_effective: "2026-07-01",
      ...overrides.circular
    }
  };
}

export function makeProposedObligation(overrides: Partial<ProposedObligation> = {}): ProposedObligation {
  return {
    category: "risk_management",
    requirement_text: "The stockbroker shall report unpaid securities beyond T+X to the exchange.",
    trigger_event: "unpaid securities beyond T+X",
    deadline_rule: "within 5 business days",
    responsible_role: "Stockbroker",
    evidence_required: "Filed report with the exchange",
    penalty_ref: "Section 11, SEBI Act, 1992",
    confidence_score: 0.9,
    derived_from_clause_id: "clause-gv-1",
    applies_to_category_names: ["Stockbroker"],
    ...overrides
  };
}

export function makeVerificationInput(overrides: Partial<GroundingVerificationInput> = {}): GroundingVerificationInput {
  return {
    proposed: makeProposedObligation(),
    source: makeSourceContext(),
    run_id: "run-gv-1",
    ...overrides
  };
}

export function makeCandidate(overrides: Partial<ContradictionCandidate> = {}): ContradictionCandidate {
  return {
    obligation_id: "ob-live-1",
    category: "risk_management",
    requirement_text: "The stockbroker shall report unpaid securities beyond T+X to the exchange.",
    trigger_event: "unpaid securities beyond T+X",
    deadline_rule: "within 3 calendar days",
    responsible_role: "Stockbroker",
    penalty_ref: "Section 11, SEBI Act, 1992",
    status: "committed",
    source_para_ref: "Para 2.1",
    source_circular_title: "Master Circular on Client Funds",
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Model output fixtures (raw shape, pre-Zod-validated — matches
// GroundingModelOutput / groundingModelOutputSchema).
// ---------------------------------------------------------------------------

const CLEAN_FIELD_ASSESSMENTS: GroundingModelOutput["field_assessments"] = [
  {
    field: "requirement_text",
    case: "directly_stated",
    supporting_spans: ["The stockbroker shall report unpaid securities beyond T+X to the exchange"],
    rationale: "Directly restated from the clause."
  },
  {
    field: "trigger_event",
    case: "directly_stated",
    supporting_spans: ["unpaid securities beyond T+X"],
    rationale: "Directly restated from the clause."
  },
  {
    field: "deadline_rule",
    case: "directly_stated",
    supporting_spans: ["within 5 business days of the Board's approval of the resolution"],
    rationale: "Directly restated from the clause, including the qualifier."
  },
  {
    field: "responsible_role",
    case: "directly_stated",
    supporting_spans: ["The stockbroker shall report"],
    rationale: "Directly restated from the clause."
  },
  {
    field: "evidence_required",
    case: "paraphrase",
    supporting_spans: ["shall report unpaid securities beyond T+X to the exchange"],
    rationale: "A faithful paraphrase of the reporting duty as the evidencing artifact."
  },
  {
    field: "penalty_ref",
    case: "directly_stated",
    supporting_spans: ["action under Section 11 of the SEBI Act, 1992 may be initiated"],
    rationale: "Directly restated from the clause."
  }
];

/** A clean pass: every field grounded, no fabrication, no dropped
 *  condition, no candidates supplied so no possible contradiction. */
export function cleanPassModelOutput(overrides: Partial<GroundingModelOutput> = {}): GroundingModelOutput {
  return {
    field_assessments: CLEAN_FIELD_ASSESSMENTS,
    candidate_assessments: [],
    summary: "All six fields are faithfully grounded in the clause text with no fabrication or dropped conditions.",
    ...overrides
  };
}

/** AC2 fixture: penalty_ref cites a specific monetary penalty absent from
 *  the clause text — fabricated. */
export function fabricatedPenaltyRefModelOutput(): GroundingModelOutput {
  return cleanPassModelOutput({
    field_assessments: CLEAN_FIELD_ASSESSMENTS.map((f) =>
      f.field === "penalty_ref"
        ? { field: "penalty_ref", case: "fabricated", supporting_spans: [], rationale: "No monetary penalty of this kind appears anywhere in the clause text." }
        : f
    ),
    summary: "penalty_ref cites a specific monetary penalty not present anywhere in the clause text."
  });
}

/** AC3 fixture: deadline_rule drops the "of the Board's approval of the
 *  resolution" qualifier that the clause text actually states. */
export function droppedConditionModelOutput(): GroundingModelOutput {
  return cleanPassModelOutput({
    field_assessments: CLEAN_FIELD_ASSESSMENTS.map((f) =>
      f.field === "deadline_rule"
        ? {
            field: "deadline_rule",
            case: "dropped_condition",
            supporting_spans: ["within 5 business days of the Board's approval of the resolution"],
            rationale: 'The proposal says "within 5 business days" but the clause qualifies this to run from the Board\'s approval of the resolution, which the proposal silently drops.'
          }
        : f
    ),
    summary: "deadline_rule drops the Board-approval qualifier the clause text actually states."
  });
}

/** AC4/AC7 fixture: one candidate genuinely conflicts (differing
 *  deadline), a second candidate is topically similar but governs a
 *  compatible, non-conflicting requirement. */
export function contradictionModelOutput(conflictingId: string, nonConflictingId?: string): GroundingModelOutput {
  const candidate_assessments: GroundingModelOutput["candidate_assessments"] = [
    {
      conflicting_obligation_id: conflictingId,
      conflict: true,
      divergent_field: "deadline_rule",
      proposed_value: "within 5 business days",
      existing_value: "within 3 calendar days",
      explanation:
        "Proposed obligation requires filing within 5 business days of the trigger event; the currently live Obligation for the same responsible_role and trigger_event requires 3 calendar days."
    }
  ];
  if (nonConflictingId) {
    candidate_assessments.push({
      conflicting_obligation_id: nonConflictingId,
      conflict: false,
      divergent_field: null,
      proposed_value: null,
      existing_value: null,
      explanation: null
    });
  }
  return cleanPassModelOutput({
    candidate_assessments,
    summary: "One live Obligation genuinely conflicts on deadline_rule; another shares the trigger_event but governs a compatible, distinct requirement."
  });
}
