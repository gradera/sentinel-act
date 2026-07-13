// Checked-in fixture + expected-output pairs for the Obligation
// Extraction Agent (Spec 03 Definition of Done: "curate at least 3 clause
// fixtures: one single-obligation with explicit deadline, one
// multi-obligation, one purely informational-only"). Text is written to
// be representative of SEBI circular style, not copied from a real
// circular.
import type { Clause, IntermediaryCategory } from "@sentinel-act/graph-schema";
import type { ObligationExtractionInput } from "../obligation-extraction.types.js";

export function makeClause(overrides: Partial<Clause> = {}): Clause {
  return {
    clause_id: "clause-test-1",
    circular_id: "circ-test-1",
    para_ref: "Para 4.2",
    text: "The stockbroker shall report client margin details to the exchange within 7 working days of the end of each calendar month, failing which action under Section 11 of the SEBI Act, 1992 may be initiated.",
    embedding_ref: JSON.stringify(new Array(8).fill(0).map((_, i) => (i + 1) / 10)),
    valid_from: "2026-07-01",
    valid_to: null,
    recorded_at: "2026-07-01T00:00:00Z",
    ...overrides
  };
}

export function makeIntermediaryCategory(overrides: Partial<IntermediaryCategory> = {}): IntermediaryCategory {
  return { category_id: "cat-stockbroker", name: "Stockbroker", ...overrides };
}

export function makeExtractionInput(overrides: Partial<ObligationExtractionInput> = {}): ObligationExtractionInput {
  return {
    clause: makeClause(),
    circularContext: {
      circular_id: "circ-test-1",
      title: "Circular on Client Margin Reporting",
      category: "Circular",
      date_effective: "2026-07-01"
    },
    knownIntermediaryCategories: [makeIntermediaryCategory()],
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Fixture 1: single, clear obligation with an explicit deadline.
// ---------------------------------------------------------------------------
export const SINGLE_OBLIGATION_CLAUSE_TEXT =
  "The stockbroker shall report client margin details to the exchange within 7 working days of the end of " +
  "each calendar month, failing which action under Section 11 of the SEBI Act, 1992 may be initiated.";

export function singleObligationModelOutput() {
  return {
    proposals: [
      {
        category: "reporting" as const,
        requirement_text: "The stockbroker shall report client margin details to the exchange.",
        trigger_event: "End of each calendar month",
        deadline_rule: "T+7 working days from trigger_event",
        responsible_role: "Compliance Officer",
        evidence_required: "Signed margin report filed with the exchange",
        penalty_ref: "Section 11, SEBI Act, 1992",
        applies_to_category_names: ["Stockbroker"],
        applies_to_unknown_category_names: [],
        model_self_reported: 0.92,
        extraction_index: 0
      }
    ],
    informational_only: false,
    informational_reason: null
  };
}

// ---------------------------------------------------------------------------
// Fixture 2: two distinct duties in one clause (reporting + record-retention).
// ---------------------------------------------------------------------------
export const MULTI_OBLIGATION_CLAUSE_TEXT =
  "The intermediary shall report every client grievance to the Investor Grievance Cell within 3 working days of " +
  "receipt, and shall separately retain all grievance-related records, including correspondence and resolution " +
  "notes, for a minimum period of 5 years from the date of resolution.";

export function multiObligationModelOutput() {
  return {
    proposals: [
      {
        category: "investor_grievance" as const,
        requirement_text: "The intermediary shall report every client grievance to the Investor Grievance Cell.",
        trigger_event: "Receipt of a client grievance",
        deadline_rule: "T+3 working days from trigger_event",
        responsible_role: "unspecified — see clause",
        evidence_required: "Grievance report filed with the Investor Grievance Cell",
        penalty_ref: null,
        applies_to_category_names: ["Stockbroker"],
        applies_to_unknown_category_names: [],
        model_self_reported: 0.88,
        extraction_index: 0
      },
      {
        category: "record_keeping" as const,
        requirement_text:
          "The intermediary shall retain all grievance-related records, including correspondence and resolution notes.",
        trigger_event: "Resolution of a client grievance",
        deadline_rule: "5 years from date of resolution",
        responsible_role: "unspecified — see clause",
        evidence_required: "Archived grievance records available for inspection",
        penalty_ref: null,
        applies_to_category_names: ["Stockbroker"],
        applies_to_unknown_category_names: [],
        model_self_reported: 0.87,
        extraction_index: 1
      }
    ],
    informational_only: false,
    informational_reason: null
  };
}

// ---------------------------------------------------------------------------
// Fixture 3: purely informational / preambular clause — no obligation.
// ---------------------------------------------------------------------------
export const INFORMATIONAL_CLAUSE_TEXT =
  "This circular is issued under Section 11(1) of the Securities and Exchange Board of India Act, 1992, read with " +
  "Section 11A of the Securities Contracts (Regulation) Act, 1956, to protect the interests of investors in " +
  "securities and to promote the development of, and to regulate, the securities market.";

export function informationalModelOutput() {
  return {
    proposals: [],
    informational_only: true,
    informational_reason: "purely definitional clause citing the statutory authority under which the circular is issued"
  };
}
