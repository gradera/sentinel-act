// Server-side decision validation rules shared by
// app/api/console/items/[obligationId]/decisions/route.ts — extracted into
// this pure, dependency-free module (Spec 09 Task 11 test-writing stage) so
// the actual security-relevant rules (which actions a tier allows, whether a
// rationale is required) are unit-testable directly, without constructing a
// `NextRequest` and exercising the whole route handler for every case.
//
// THIS is the enforcement layer that matters (NFR-Security-1/FR-25/FR-27):
// SignOffPanel.tsx's own `actionsFor(reviewGate)` (client-side action-set
// builder for the sign-off sheet's buttons) is UX only — hiding a button a
// malicious or buggy client could still POST around. The decisions route
// calling the functions below, server-side, before ever calling the
// Orchestrator, is what actually enforces FR-27 ("approve" structurally
// absent for ESCALATE) and FR-25 (rationale required at Tier C/ESCALATE).
import type { ReviewableTier } from "./obligation-tier";
import type { DecisionAction } from "./types";

/** FR-27: the ESCALATE action set never includes "approve" — escalate or
 *  reject only. Tier B/C both allow approve/reject (the "escalate_to_tier_c"
 *  action is a routing concept that only ever applies to ESCALATE items;
 *  see decisions/route.ts's top-of-file doc comment for the full analysis
 *  of why it has no B/C equivalent). */
export function allowedDecisionActions(tier: ReviewableTier): DecisionAction[] {
  if (tier === "ESCALATE") {
    return ["escalate_to_tier_c", "reject"];
  }
  return ["approve", "reject"];
}

/** `true` iff `decision` is a member of `allowedDecisionActions(tier)`. The
 *  decisions route uses this specifically to decide FR-27's 403
 *  `ACTION_NOT_ALLOWED_FOR_TIER` case ("approve" on an ESCALATE item) — it
 *  does NOT use this for `escalate_to_tier_c` on a non-ESCALATE item, which
 *  is a distinct `400 INVALID_DECISION` case with its own message (see the
 *  route's own handling), not a tier-mismatch-on-an-otherwise-valid-action
 *  case. */
export function isDecisionAllowedForTier(tier: ReviewableTier, decision: DecisionAction): boolean {
  return allowedDecisionActions(tier).includes(decision);
}

/** FR-17/FR-25: rationale is optional at Tier B, required (non-empty,
 *  trimmed) at Tier C and ESCALATE — encoded directly by
 *  `TierBReviewGateView.rationaleRequired: false` vs.
 *  `TierCReviewGateView`/`EscalateReviewGateView`'s literal
 *  `rationaleRequired: true` (types.ts), reproduced here as a tier-keyed
 *  function so the decisions route's request-body validation doesn't need a
 *  `ReviewGateView` in hand just to answer this question. */
export function isRationaleRequired(tier: ReviewableTier): boolean {
  return tier !== "B";
}
