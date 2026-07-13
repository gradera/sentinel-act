// Spec 03 §10 unit tests: obligationProposalListSchema / obligationProposalSchema.
import { describe, expect, it } from "vitest";
import { obligationProposalListSchema, obligationProposalSchema } from "../obligation-extraction.schema.js";

function wellFormedProposal(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    category: "reporting",
    requirement_text: "The stockbroker shall report client margin details to the exchange.",
    trigger_event: "Receipt of client margin",
    deadline_rule: "T+7 calendar days from trigger_event",
    responsible_role: "Compliance Officer",
    evidence_required: "Signed margin report filed with exchange",
    penalty_ref: null,
    applies_to_category_names: ["Stockbroker"],
    applies_to_unknown_category_names: [],
    model_self_reported: 0.85,
    extraction_index: 0,
    ...overrides
  };
}

describe("obligationProposalSchema", () => {
  it("accepts a well-formed proposal", () => {
    const result = obligationProposalSchema.safeParse(wellFormedProposal());
    expect(result.success).toBe(true);
  });

  it("rejects a missing required field (requirement_text)", () => {
    const proposal = wellFormedProposal() as Record<string, unknown>;
    delete proposal.requirement_text;
    const result = obligationProposalSchema.safeParse(proposal);
    expect(result.success).toBe(false);
  });

  it("rejects an out-of-enum category", () => {
    const result = obligationProposalSchema.safeParse(wellFormedProposal({ category: "not_a_real_category" }));
    expect(result.success).toBe(false);
  });

  it("rejects empty applies_to_category_names", () => {
    const result = obligationProposalSchema.safeParse(wellFormedProposal({ applies_to_category_names: [] }));
    expect(result.success).toBe(false);
  });

  it("defaults applies_to_unknown_category_names to [] when omitted", () => {
    const proposal = wellFormedProposal() as Record<string, unknown>;
    delete proposal.applies_to_unknown_category_names;
    const result = obligationProposalSchema.safeParse(proposal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.applies_to_unknown_category_names).toEqual([]);
    }
  });

  it("accepts the literal deadline_rule value NONE", () => {
    const result = obligationProposalSchema.safeParse(wellFormedProposal({ deadline_rule: "NONE" }));
    expect(result.success).toBe(true);
  });
});

describe("obligationProposalListSchema — cross-field invariants", () => {
  it("accepts a non-empty proposals list with informational_only: false", () => {
    const result = obligationProposalListSchema.safeParse({
      proposals: [wellFormedProposal()],
      informational_only: false,
      informational_reason: null
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty proposals list with informational_only: true and a reason", () => {
    const result = obligationProposalListSchema.safeParse({
      proposals: [],
      informational_only: true,
      informational_reason: "purely definitional clause citing statutory authority"
    });
    expect(result.success).toBe(true);
  });

  it("rejects informational_only: true with a non-empty proposals list", () => {
    const result = obligationProposalListSchema.safeParse({
      proposals: [wellFormedProposal()],
      informational_only: true,
      informational_reason: "should not happen"
    });
    expect(result.success).toBe(false);
  });

  it("rejects informational_only: false with an empty proposals list", () => {
    const result = obligationProposalListSchema.safeParse({
      proposals: [],
      informational_only: false,
      informational_reason: null
    });
    expect(result.success).toBe(false);
  });

  it("rejects informational_only: true with a null informational_reason", () => {
    const result = obligationProposalListSchema.safeParse({
      proposals: [],
      informational_only: true,
      informational_reason: null
    });
    expect(result.success).toBe(false);
  });
});
