// Spec 03 §10/§6.1-§6.3 unit tests: computeConfidenceScore() and its
// pure helper functions. Exhaustive table per the spec's test plan.
import { describe, expect, it } from "vitest";
import {
  computeConfidenceScore,
  computeCompletenessPenalty,
  computeAmbiguityPenalty,
  computeGraphRagBonus,
  type ConfidenceScoreProposalInput
} from "../confidence-score.js";

function baseProposal(overrides: Partial<ConfidenceScoreProposalInput> = {}): ConfidenceScoreProposalInput {
  return {
    requirement_text: "The stockbroker shall report client margin details to the exchange within the stated window.",
    deadline_rule: "T+7 calendar days from trigger_event",
    responsible_role: "Compliance Officer",
    evidence_required: "Signed margin report filed with exchange",
    penalty_ref: null,
    applies_to_category_names: ["Stockbroker"],
    applies_to_unknown_category_names: [],
    clauseText: "The stockbroker shall report client margin details to the exchange within 7 working days.",
    ...overrides
  };
}

describe("computeConfidenceScore — full table", () => {
  it("all fields present + high self-report -> high final score, zero penalties", () => {
    const breakdown = computeConfidenceScore(baseProposal(), 0.95, {
      is_first_seen_obligation_type: false,
      topSimilarity: 0
    });
    expect(breakdown.field_completeness_penalty).toBe(0);
    expect(breakdown.ambiguity_penalty).toBe(0);
    expect(breakdown.graphrag_support_bonus).toBe(0);
    expect(breakdown.final).toBeCloseTo(0.95, 5);
  });

  it("missing penalty_ref on a clause with clear penalty language applies the completeness penalty", () => {
    const proposal = baseProposal({
      penalty_ref: null,
      clauseText: "Failure to comply shall attract a penalty under the SEBI Act, 1992."
    });
    const penalty = computeCompletenessPenalty(proposal);
    expect(penalty).toBeCloseTo(0.15, 5);
  });

  it("penalty_ref null on a genuinely penalty-free clause applies no penalty", () => {
    const proposal = baseProposal({
      penalty_ref: null,
      clauseText: "The stockbroker shall report client margin details to the exchange within 7 working days."
    });
    const penalty = computeCompletenessPenalty(proposal);
    expect(penalty).toBe(0);
  });

  it("deadline_rule === NONE on a clause with no deadline language is never penalized", () => {
    const proposal = baseProposal({
      deadline_rule: "NONE",
      clauseText: "The stockbroker shall maintain records of all client complaints received."
    });
    const penalty = computeCompletenessPenalty(proposal);
    expect(penalty).toBe(0);
  });

  it("unspecified responsible_role and evidence_required each apply a 0.10 penalty", () => {
    const proposal = baseProposal({
      responsible_role: "unspecified — see clause",
      evidence_required: "unspecified — see clause"
    });
    const penalty = computeCompletenessPenalty(proposal);
    expect(penalty).toBeCloseTo(0.2, 5);
  });

  it("zero known-category matches (fully unknown categories) applies a 0.10 completeness penalty", () => {
    const proposal = baseProposal({ applies_to_category_names: [], applies_to_unknown_category_names: ["New Category"] });
    const penalty = computeCompletenessPenalty(proposal);
    expect(penalty).toBeCloseTo(0.1, 5);
  });

  it("completeness penalty is capped at 0.35 even when every condition fires", () => {
    const proposal = baseProposal({
      responsible_role: "unspecified — see clause",
      evidence_required: "unspecified — see clause",
      penalty_ref: null,
      clauseText: "Failure to comply shall attract a penalty and a fine under the SEBI Act, 1992.",
      applies_to_category_names: [],
      applies_to_unknown_category_names: ["New Category"]
    });
    // 0.10 + 0.10 + 0.15 + 0.10 = 0.45, capped at 0.35.
    const penalty = computeCompletenessPenalty(proposal);
    expect(penalty).toBe(0.35);
  });

  it("hedged/ambiguous model language applies the ambiguity penalty", () => {
    const penalty = computeAmbiguityPenalty({
      requirement_text: "It appears to require reporting, though this may not apply in all cases.",
      applies_to_unknown_category_names: []
    });
    expect(penalty).toBeGreaterThan(0);
  });

  it("non-empty applies_to_unknown_category_names contributes to the ambiguity penalty", () => {
    const penalty = computeAmbiguityPenalty({
      requirement_text: "The entity shall report the incident promptly.",
      applies_to_unknown_category_names: ["Some New Category"]
    });
    expect(penalty).toBeCloseTo(0.15, 5);
  });

  it("ambiguity penalty is capped at 0.25", () => {
    const penalty = computeAmbiguityPenalty({
      requirement_text: "It may possibly and appears to unclear whether if applicable require reporting.",
      applies_to_unknown_category_names: ["Some New Category"]
    });
    expect(penalty).toBeLessThanOrEqual(0.25);
  });

  it("high similarity (>= 0.90) with is_first_seen_obligation_type: false applies and caps the bonus at 0.15", () => {
    const bonus = computeGraphRagBonus({ is_first_seen_obligation_type: false, topSimilarity: 0.97 });
    expect(bonus).toBe(0.15);
  });

  it("mid similarity (0.75-0.90) applies the smaller 0.08 bonus", () => {
    const bonus = computeGraphRagBonus({ is_first_seen_obligation_type: false, topSimilarity: 0.8 });
    expect(bonus).toBe(0.08);
  });

  it("low similarity or cold start applies no bonus", () => {
    expect(computeGraphRagBonus({ is_first_seen_obligation_type: false, topSimilarity: 0.5 })).toBe(0);
    expect(computeGraphRagBonus({ is_first_seen_obligation_type: false, topSimilarity: 0 })).toBe(0);
  });

  it("a first-seen obligation type NEVER receives a graphrag bonus, even at very high similarity", () => {
    const bonus = computeGraphRagBonus({ is_first_seen_obligation_type: true, topSimilarity: 0.99 });
    expect(bonus).toBe(0);
  });

  it("final score is clamped to [0, 1] on both ends", () => {
    const highClamp = computeConfidenceScore(baseProposal(), 1, {
      is_first_seen_obligation_type: false,
      topSimilarity: 0.99
    });
    expect(highClamp.final).toBeLessThanOrEqual(1);

    const lowClamp = computeConfidenceScore(
      baseProposal({
        responsible_role: "unspecified — see clause",
        evidence_required: "unspecified — see clause",
        penalty_ref: null,
        clauseText: "Failure to comply shall attract a penalty and a fine under the SEBI Act, 1992.",
        applies_to_category_names: [],
        applies_to_unknown_category_names: ["New Category"],
        requirement_text: "It may possibly appear to unclear whether if applicable require reporting."
      }),
      0,
      { is_first_seen_obligation_type: true, topSimilarity: 0 }
    );
    expect(lowClamp.final).toBe(0);
  });

  it("returns the full breakdown with model_self_reported echoed unchanged", () => {
    const breakdown = computeConfidenceScore(baseProposal(), 0.6, {
      is_first_seen_obligation_type: false,
      topSimilarity: 0
    });
    expect(breakdown.model_self_reported).toBe(0.6);
    expect(breakdown.final).toBe(
      breakdown.model_self_reported - breakdown.field_completeness_penalty - breakdown.ambiguity_penalty + breakdown.graphrag_support_bonus
    );
  });
});
