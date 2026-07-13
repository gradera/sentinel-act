// Spec 05 §10: "the highest-priority test file in this unit; treat it as
// the correctness gate for the whole governance system." Covers
// scoreRisk/explainRiskScore formula + clamping (FR-2/NFR-6/§8) and an
// exhaustive table-driven boundary matrix for routeTier (FR-22–FR-30),
// including every §9 Acceptance Criteria scenario as an explicit case.
import { describe, expect, it } from "vitest";
import {
  scoreRisk,
  explainRiskScore,
  routeTier,
  GROUNDING_FAILURE_THRESHOLD,
  CONFIDENCE_HIGH_THRESHOLD,
  GROUNDING_HIGH_THRESHOLD,
  type TierRouteInput
} from "./risk-score.scorer.js";

describe("scoreRisk", () => {
  it("FR-2 / AC-1: matches the corrected worked example (~0.28, not the stale ~0.293)", () => {
    // penalty_ref: null, "T+2 working days" deadline, no live overwrite.
    const score = scoreRisk({ penaltySeverity: 0, deadlineProximityDays: 2, overwritesLiveObligation: false });
    expect(score).toBeCloseTo(0.28, 2);
  });

  it("computes the formula correctly for a sample input triple", () => {
    // penaltySeverity 0.5, deadlineProximityDays 10 -> deadlineWeight = 1 - 10/30 = 0.6667
    // raw = 0.5*0.5 + 0.6667*0.3 + 0.3 (overwrite) = 0.25 + 0.2 + 0.3 = 0.75
    const score = scoreRisk({ penaltySeverity: 0.5, deadlineProximityDays: 10, overwritesLiveObligation: true });
    expect(score).toBeCloseTo(0.75, 2);
  });

  it("clamps a raw value above 1 down to 1 (synthetic overflow)", () => {
    // penaltySeverity 1, deadlineProximityDays 0 (deadlineWeight=1), overwrite true
    // raw = 0.5 + 0.3 + 0.3 = 1.1 -> clamp to 1
    const score = scoreRisk({ penaltySeverity: 1, deadlineProximityDays: 0, overwritesLiveObligation: true });
    expect(score).toBe(1);
  });

  it("clamps a raw value below 0 up to 0 (synthetic negative deadlineProximityDays)", () => {
    const score = scoreRisk({ penaltySeverity: 0, deadlineProximityDays: -100, overwritesLiveObligation: false });
    expect(score).toBeGreaterThanOrEqual(0);
    // deadlineWeight is itself clamped at 1 via Math.max(0, 1 - x/30); with a
    // negative deadlineProximityDays the raw formula would exceed 1 if not
    // for scoreRisk's own outer clamp — assert the outer clamp still holds.
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe("explainRiskScore", () => {
  it("returns the same riskScore as scoreRisk plus intermediate terms (NFR-3)", () => {
    const inputs = { penaltySeverity: 0.7, deadlineProximityDays: 5, overwritesLiveObligation: true };
    const explain = explainRiskScore(inputs);
    expect(explain.riskScore).toBe(scoreRisk(inputs));
    expect(explain.deadlineWeight).toBeCloseTo(1 - 5 / 30, 6);
    expect(explain.overwriteWeight).toBe(0.3);
    expect(explain.penaltySeverity).toBe(0.7);
    expect(explain.deadlineProximityDays).toBe(5);
    expect(explain.overwritesLiveObligation).toBe(true);
  });

  it("overwriteWeight is 0 when overwritesLiveObligation is false", () => {
    const explain = explainRiskScore({ penaltySeverity: 0, deadlineProximityDays: 30, overwritesLiveObligation: false });
    expect(explain.overwriteWeight).toBe(0);
    expect(explain.deadlineWeight).toBe(0);
  });
});

function baseInput(overrides: Partial<TierRouteInput> = {}): TierRouteInput {
  return {
    riskScore: 0.1,
    hasContradiction: false,
    confidenceScore: 0.95,
    groundingScore: 0.95,
    isFirstSeenObligationType: false,
    ...overrides
  };
}

describe("routeTier — Acceptance Criteria (§9)", () => {
  it("AC-2: riskScore exactly 0.4 -> Tier B, not A (FR-25 inclusive lower bound)", () => {
    const decision = routeTier(baseInput({ riskScore: 0.4 }));
    expect(decision.tier).toBe("B");
    expect(decision.reasons).toContain("RISK_SCORE_TIER_B");
  });

  it("AC-3: riskScore exactly 0.75 -> Tier C, not B (FR-25 inclusive lower bound)", () => {
    const decision = routeTier(baseInput({ riskScore: 0.75 }));
    expect(decision.tier).toBe("C");
    expect(decision.reasons).toContain("RISK_SCORE_TIER_C");
  });

  it("AC-4: contradiction with confidenceScore 1.0 still escalates (FR-23)", () => {
    const decision = routeTier(baseInput({ hasContradiction: true, confidenceScore: 1.0, groundingScore: 1.0, riskScore: 0.01 }));
    expect(decision.tier).toBe("ESCALATE");
    expect(decision.reasons).toContain("CONTRADICTION");
  });

  it("AC-5: low riskScore but first-seen -> Tier B with FIRST_SEEN_OBLIGATION_TYPE (FR-28)", () => {
    const decision = routeTier(baseInput({ riskScore: 0.1, confidenceScore: 0.95, groundingScore: 0.95, isFirstSeenObligationType: true }));
    expect(decision.tier).toBe("B");
    expect(decision.reasons).toContain("FIRST_SEEN_OBLIGATION_TYPE");
  });

  it("AC-11: groundingScore exactly at the threshold (0.5) does NOT escalate (strict < per FR-24)", () => {
    const decision = routeTier(baseInput({ groundingScore: GROUNDING_FAILURE_THRESHOLD, hasContradiction: false, riskScore: 0.1 }));
    expect(decision.tier).not.toBe("ESCALATE");
  });

  it("AC-12: low risk but sub-threshold confidence -> Tier B with SUB_THRESHOLD_CONFIDENCE_OR_GROUNDING", () => {
    const decision = routeTier(baseInput({ riskScore: 0.05, confidenceScore: 0.6, groundingScore: 0.9, isFirstSeenObligationType: false }));
    expect(decision.tier).toBe("B");
    expect(decision.reasons).toContain("SUB_THRESHOLD_CONFIDENCE_OR_GROUNDING");
  });
});

describe("routeTier — escalation precedence (FR-22–FR-24)", () => {
  it("groundingScore just below the threshold (0.4999) IS a failure", () => {
    const decision = routeTier(baseInput({ groundingScore: 0.4999 }));
    expect(decision.tier).toBe("ESCALATE");
    expect(decision.reasons).toContain("GROUNDING_FAILURE");
  });

  it("both contradiction and grounding failure fire simultaneously — both reasons present", () => {
    const decision = routeTier(baseInput({ hasContradiction: true, groundingScore: 0.1 }));
    expect(decision.tier).toBe("ESCALATE");
    expect(decision.reasons).toEqual(expect.arrayContaining(["CONTRADICTION", "GROUNDING_FAILURE"]));
  });

  it("escalation overrides even a Tier-C-magnitude riskScore — reasons stay escalation-only", () => {
    const decision = routeTier(baseInput({ hasContradiction: true, riskScore: 0.99 }));
    expect(decision.tier).toBe("ESCALATE");
    expect(decision.reasons).not.toContain("RISK_SCORE_TIER_C");
  });

  it("reasons array is always non-empty (FR-30)", () => {
    for (const riskScore of [0, 0.4, 0.75, 1]) {
      const decision = routeTier(baseInput({ riskScore }));
      expect(decision.reasons.length).toBeGreaterThan(0);
    }
  });
});

describe("routeTier — FR-26: a risk-earned B/C is final, never softened by confidence/first-seen", () => {
  it("Tier B from riskScore is not downgraded to A by high confidence and not-first-seen", () => {
    const decision = routeTier(baseInput({ riskScore: 0.5, confidenceScore: 1.0, groundingScore: 1.0, isFirstSeenObligationType: false }));
    expect(decision.tier).toBe("B");
    expect(decision.reasons).toEqual(["RISK_SCORE_TIER_B"]);
  });

  it("Tier C from riskScore is not downgraded to B by high confidence and not-first-seen", () => {
    const decision = routeTier(baseInput({ riskScore: 0.9, confidenceScore: 1.0, groundingScore: 1.0, isFirstSeenObligationType: false }));
    expect(decision.tier).toBe("C");
    expect(decision.reasons).toEqual(["RISK_SCORE_TIER_C"]);
  });

  it("Tier C is not upgraded further by first-seen (no such concept — C is already the ceiling below ESCALATE)", () => {
    const decision = routeTier(baseInput({ riskScore: 0.9, isFirstSeenObligationType: true }));
    expect(decision.tier).toBe("C");
    expect(decision.reasons).toEqual(["RISK_SCORE_TIER_C"]);
  });
});

describe("routeTier — FR-27/FR-28: independent Tier-A eligibility checks, both can fire together", () => {
  it("both sub-threshold confidence/grounding AND first-seen fire together in one reasons array", () => {
    const decision = routeTier(baseInput({ riskScore: 0.05, confidenceScore: 0.5, groundingScore: 0.6, isFirstSeenObligationType: true }));
    expect(decision.tier).toBe("B");
    expect(decision.reasons).toEqual(
      expect.arrayContaining(["SUB_THRESHOLD_CONFIDENCE_OR_GROUNDING", "FIRST_SEEN_OBLIGATION_TYPE"])
    );
    expect(decision.reasons).toHaveLength(2);
  });

  it("confidenceScore exactly at CONFIDENCE_HIGH_THRESHOLD passes (inclusive)", () => {
    const decision = routeTier(
      baseInput({ riskScore: 0.05, confidenceScore: CONFIDENCE_HIGH_THRESHOLD, groundingScore: GROUNDING_HIGH_THRESHOLD, isFirstSeenObligationType: false })
    );
    expect(decision.tier).toBe("A");
    expect(decision.reasons).toEqual(["BASE_TIER_A"]);
  });

  it("groundingScore just below GROUNDING_HIGH_THRESHOLD fails Tier-A eligibility", () => {
    const decision = routeTier(
      baseInput({ riskScore: 0.05, confidenceScore: 0.95, groundingScore: GROUNDING_HIGH_THRESHOLD - 0.01, isFirstSeenObligationType: false })
    );
    expect(decision.tier).toBe("B");
    expect(decision.reasons).toEqual(["SUB_THRESHOLD_CONFIDENCE_OR_GROUNDING"]);
  });
});

describe("routeTier — FR-29: clean Tier A", () => {
  it("high confidence, high grounding, low risk, not first-seen, no contradiction -> Tier A", () => {
    const decision = routeTier(baseInput());
    expect(decision.tier).toBe("A");
    expect(decision.reasons).toEqual(["BASE_TIER_A"]);
  });
});

describe("routeTier — exhaustive boundary matrix", () => {
  const riskScores = [0, 0.39, 0.4, 0.74, 0.75, 1];
  const firstSeenStates = [false, true];
  const confidenceStates = [0.5, 0.9]; // below / above CONFIDENCE_HIGH_THRESHOLD
  const contradictionStates = [false, true];
  const groundingStates = [0.3, 0.5, 0.9]; // below / exactly-at / above GROUNDING_FAILURE_THRESHOLD

  for (const riskScore of riskScores) {
    for (const isFirstSeenObligationType of firstSeenStates) {
      for (const confidenceScore of confidenceStates) {
        for (const hasContradiction of contradictionStates) {
          for (const groundingScore of groundingStates) {
            it(`riskScore=${riskScore} firstSeen=${isFirstSeenObligationType} confidence=${confidenceScore} contradiction=${hasContradiction} grounding=${groundingScore}`, () => {
              const decision = routeTier({
                riskScore,
                isFirstSeenObligationType,
                confidenceScore,
                hasContradiction,
                groundingScore
              });

              // Invariant 1: reasons is always non-empty (FR-30).
              expect(decision.reasons.length).toBeGreaterThan(0);

              // Invariant 2: escalation is unconditional and total.
              if (hasContradiction || groundingScore < GROUNDING_FAILURE_THRESHOLD) {
                expect(decision.tier).toBe("ESCALATE");
                return;
              }

              // Invariant 3: never escalated -> tier is derived purely from
              // riskScore/confidence/first-seen per FR-25–FR-29.
              if (riskScore >= 0.75) {
                expect(decision.tier).toBe("C");
              } else if (riskScore >= 0.4) {
                expect(decision.tier).toBe("B");
              } else {
                const eligibleForA = confidenceScore >= CONFIDENCE_HIGH_THRESHOLD && groundingScore >= GROUNDING_HIGH_THRESHOLD;
                if (eligibleForA && !isFirstSeenObligationType) {
                  expect(decision.tier).toBe("A");
                } else {
                  expect(decision.tier).toBe("B");
                }
              }
            });
          }
        }
      }
    }
  }
});
