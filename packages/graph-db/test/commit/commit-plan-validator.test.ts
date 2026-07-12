// commit-plan-validator.test.ts (spec §10): rejects out-of-range scores,
// rejects non-ISO dates, accepts a minimal valid plan. FR-13.
import { describe, expect, it } from "vitest";
import { validateCommitPlan } from "../../src/commit/commit-plan-validator.js";
import { ValidationError } from "../../src/errors.js";

function minimalValidPlan() {
  return {
    proposalId: "proposal-1",
    nodes: {
      obligations: [
        {
          obligation_id: "ob-1",
          derived_from_clause_id: "cl-1",
          category: "disclosure",
          requirement_text: "req",
          trigger_event: "trigger",
          deadline_rule: "T+5",
          responsible_role: "Compliance Officer",
          evidence_required: "log",
          penalty_ref: null,
          confidence_score: 0.9,
          grounding_score: 0.85,
          status: "proposed",
          valid_from: "2026-01-01",
          valid_to: null
        }
      ]
    },
    edges: []
  };
}

describe("validateCommitPlan", () => {
  it("accepts a minimal valid plan", () => {
    const plan = minimalValidPlan();
    const result = validateCommitPlan(plan);
    expect(result.proposalId).toBe("proposal-1");
    expect(result.nodes.obligations).toHaveLength(1);
  });

  it("rejects confidence_score: 1.5 (out of [0,1])", () => {
    const plan = minimalValidPlan();
    plan.nodes.obligations![0].confidence_score = 1.5;
    expect(() => validateCommitPlan(plan)).toThrow(ValidationError);
  });

  it("rejects a non-ISO effectiveDate on a supersession instruction", () => {
    const plan = {
      ...minimalValidPlan(),
      supersessions: [{ kind: "Obligation", oldId: "ob-0", effectiveDate: "07/03/2026" }]
    };
    expect(() => validateCommitPlan(plan)).toThrow(ValidationError);
  });

  it("rejects a plan missing the required edges array", () => {
    const plan = minimalValidPlan() as Partial<ReturnType<typeof minimalValidPlan>>;
    delete plan.edges;
    expect(() => validateCommitPlan(plan)).toThrow(ValidationError);
  });

  it("surfaces field-level zod issues on the thrown ValidationError", () => {
    const plan = minimalValidPlan();
    plan.nodes.obligations![0].confidence_score = 1.5;
    try {
      validateCommitPlan(plan);
      expect.fail("expected validateCommitPlan to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).issues).toBeDefined();
    }
  });
});
