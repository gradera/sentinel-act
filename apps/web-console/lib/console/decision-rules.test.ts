// Spec 09 §12: "rationale-required validation logic" and "the
// contradiction-item action-set builder (no 'approve' for ESCALATE)" — the
// SERVER-SIDE versions (decision-rules.ts, used directly by
// app/api/console/items/[obligationId]/decisions/route.ts), which is the
// one that matters for security per this stage's brief: SignOffPanel.tsx's
// client-side `actionsFor` only controls which buttons render, it is not
// what stops a crafted POST body.
import { describe, expect, it } from "vitest";
import { allowedDecisionActions, isDecisionAllowedForTier, isRationaleRequired } from "./decision-rules";

// FR-27: for tier === "ESCALATE" items, "approve" MUST be structurally
// absent from the allowed action set (not merely hidden behind a disabled
// button) — see decisions/route.test.ts's "FR-27" describe block for the
// server-enforced 403 ACTION_NOT_ALLOWED_FOR_TIER half of this requirement.
describe("allowedDecisionActions", () => {
  it("ESCALATE: escalate_to_tier_c and reject only — 'approve' is structurally absent (FR-27)", () => {
    const actions = allowedDecisionActions("ESCALATE");
    expect(actions).toEqual(["escalate_to_tier_c", "reject"]);
    expect(actions).not.toContain("approve");
  });

  it("Tier B: approve and reject", () => {
    expect(allowedDecisionActions("B")).toEqual(["approve", "reject"]);
  });

  it("Tier C: approve and reject", () => {
    expect(allowedDecisionActions("C")).toEqual(["approve", "reject"]);
  });
});

describe("isDecisionAllowedForTier", () => {
  it("'approve' is NOT allowed for ESCALATE", () => {
    expect(isDecisionAllowedForTier("ESCALATE", "approve")).toBe(false);
  });

  it("'approve' IS allowed for Tier B and Tier C", () => {
    expect(isDecisionAllowedForTier("B", "approve")).toBe(true);
    expect(isDecisionAllowedForTier("C", "approve")).toBe(true);
  });

  it("'reject' is allowed for every tier", () => {
    expect(isDecisionAllowedForTier("B", "reject")).toBe(true);
    expect(isDecisionAllowedForTier("C", "reject")).toBe(true);
    expect(isDecisionAllowedForTier("ESCALATE", "reject")).toBe(true);
  });

  it("'escalate_to_tier_c' is only allowed for ESCALATE", () => {
    expect(isDecisionAllowedForTier("ESCALATE", "escalate_to_tier_c")).toBe(true);
    expect(isDecisionAllowedForTier("B", "escalate_to_tier_c")).toBe(false);
    expect(isDecisionAllowedForTier("C", "escalate_to_tier_c")).toBe(false);
  });
});

// FR-17: rationale is optional at Tier B (always-visible textarea, empty
// submission valid). FR-25: rationale is required (non-empty after trim)
// for every Tier C (and, per decision-rules.ts's own doc comment, ESCALATE)
// decision submission — this is the actual server-side enforcement layer,
// see decisions/route.test.ts's "FR-25" describe block for the route-level
// 400 RATIONALE_REQUIRED half of this requirement.
describe("isRationaleRequired", () => {
  it("Tier B: rationale is optional (FR-17)", () => {
    expect(isRationaleRequired("B")).toBe(false);
  });

  it("Tier C: rationale is required (FR-25)", () => {
    expect(isRationaleRequired("C")).toBe(true);
  });

  it("ESCALATE: rationale is required (FR-25 extends to ESCALATE)", () => {
    expect(isRationaleRequired("ESCALATE")).toBe(true);
  });
});
