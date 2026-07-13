// Spec 08 FR-24a: the HTTP wire contract for
// `GET /api/orchestrator/obligations/:obligationId/review-gate` is Spec
// 09's own proposed `ReviewGateView` (§4/§5) — `TierBReviewGateView |
// TierCReviewGateView | EscalateReviewGateView` — computed per calling
// `reviewerId`, NOT this workflow's narrower internal `ReviewGateView`
// (orchestrator.logic.ts's `deriveReviewGateView`, which only tracks a
// 4-value status + a flat `reveal: HumanReview[] | null`). This module is
// the pure, unit-testable transform between the two.
//
// These wire types intentionally mirror Spec 09 §4's shapes field-for-field
// so a later BFF stage can pass this response straight through without
// reshaping. They are duplicated here (not imported from
// apps/web-console/lib/console/types.ts) deliberately: apps/orchestrator
// and apps/web-console are two independently deployed processes, and Spec
// 09 §5.1/§13 itself flags the shared-import-vs-published-package tension
// as still open — kept in lockstep by contract, not by cross-app import.
import type { HumanReview } from "@sentinel-act/graph-schema";
import type { ReviewGateView as InternalReviewGateView } from "./orchestrator.logic.js";

// ---------------------------------------------------------------------------
// Spec 09 §4 wire types.
// ---------------------------------------------------------------------------

/** Spec 09 §4's 5-value Tier C gate status (distinct from this workflow's
 *  internal 4-value `ReviewGateStatus` in orchestrator.logic.ts). */
export type TierCGateStatus =
  | "unclaimed" // no reviewer has claimed either slot yet (or: viewer has not claimed and is not entitled to know more — see deriveTierCView)
  | "claimed_by_viewer" // viewer holds a slot, has not decided
  | "viewer_submitted_awaiting_peer" // viewer decided, peer has not (yet) — independence boundary
  | "resolved_agree" // both decided, same decision -> committed/rejected
  | "resolved_disagree"; // both decided, different decision -> escalated

export interface TierCReviewGateView {
  kind: "tier_c";
  rationaleRequired: true;
  viewerSlot: "maker" | "checker" | null;
  status: TierCGateStatus;
  reveal: { reviews: HumanReview[]; agreement: boolean } | null;
}

export interface TierBReviewGateView {
  kind: "tier_b";
  rationaleRequired: false;
  existingDecision: HumanReview | null; // non-null once decided (renders as read-only confirmation)
}

export interface EscalateReviewGateView {
  kind: "escalate";
  rationaleRequired: true; // required to reject; approve is not offered at all (FR-27)
  existingDecision: HumanReview | null;
}

export type WireReviewGateView = TierBReviewGateView | TierCReviewGateView | EscalateReviewGateView;

export interface ClaimSlots {
  maker: string | null;
  checker: string | null;
}

// ---------------------------------------------------------------------------
// Transform.
// ---------------------------------------------------------------------------

function ownDecision(reveal: HumanReview[] | null, reviewerId: string): HumanReview | null {
  if (!reveal || reveal.length === 0) {
    return null;
  }
  // Tier B never has more than one HumanReview for the obligation; Escalate
  // (dual-review, per FR-23) may have two once resolved — always surface
  // the caller's OWN fact here, never the peer's, matching
  // TierBReviewGateView/EscalateReviewGateView's "existingDecision" doc
  // comment ("renders as read-only confirmation" of the viewer's own
  // decision).
  return reveal.find((r) => r.reviewer_id === reviewerId) ?? reveal[0] ?? null;
}

function deriveViewerSlot(claimSlots: ClaimSlots | null, reviewerId: string): "maker" | "checker" | null {
  if (!claimSlots) {
    return null;
  }
  if (claimSlots.maker === reviewerId) {
    return "maker";
  }
  if (claimSlots.checker === reviewerId) {
    return "checker";
  }
  return null;
}

/** Maps this workflow's internal `ReviewGateView` (orchestrator.logic.ts's
 *  `deriveReviewGateView`, backed by Spec 07's `getReviewsVisibleTo`) plus
 *  the caller's claim-slot state (Spec 09 §5's `viewerSlot`, sourced from
 *  `SuspendedRunIndexPort.getClaimSlots`) into Spec 09's documented
 *  `ReviewGateView` wire shape.
 *
 *  Status derivation for Tier C (the FR-24a NFR-Security-1 boundary):
 *  - internal `status === "complete"` (both reviews visible to caller) ->
 *    `resolved_agree` / `resolved_disagree`, decided by comparing the two
 *    revealed decisions. `reveal` is populated only here.
 *  - internal `status === "awaiting_checker"` means
 *    `getReviewsVisibleTo` returned exactly ONE record for this caller —
 *    which, per Spec 07's redaction rule (a caller sees [] until THEY
 *    themselves have submitted), can only be the caller's own review ->
 *    `viewer_submitted_awaiting_peer`.
 *  - internal `status === "awaiting_maker"` (nothing visible to caller
 *    yet, i.e. caller has not submitted) -> `unclaimed` if the caller
 *    holds no slot, `claimed_by_viewer` if they do. Per Spec 09's own
 *    Acceptance Criteria 2 (§9), this is reported as `unclaimed` from an
 *    uninvolved bystander's perspective even when the OTHER slot has
 *    already been claimed/decided by someone else — the point of this
 *    endpoint is that a non-participant's response carries zero
 *    information about the peer's progress. */
export function toWireReviewGateView(
  view: InternalReviewGateView,
  reviewerId: string,
  claimSlots: ClaimSlots | null
): WireReviewGateView {
  if (view.tier === "B") {
    return { kind: "tier_b", rationaleRequired: false, existingDecision: ownDecision(view.reveal, reviewerId) };
  }

  if (view.tier === "ESCALATE") {
    return { kind: "escalate", rationaleRequired: true, existingDecision: ownDecision(view.reveal, reviewerId) };
  }

  // Tier C.
  if (view.status === "complete" && view.reveal && view.reveal.length >= 2) {
    const [first, second] = view.reveal;
    const agreement = first.decision === second.decision;
    return {
      kind: "tier_c",
      rationaleRequired: true,
      viewerSlot: deriveViewerSlot(claimSlots, reviewerId),
      status: agreement ? "resolved_agree" : "resolved_disagree",
      reveal: { reviews: view.reveal, agreement }
    };
  }

  const viewerSlot = deriveViewerSlot(claimSlots, reviewerId);
  const status: TierCGateStatus =
    view.status === "awaiting_checker" ? "viewer_submitted_awaiting_peer" : viewerSlot === null ? "unclaimed" : "claimed_by_viewer";

  return { kind: "tier_c", rationaleRequired: true, viewerSlot, status, reveal: null };
}
