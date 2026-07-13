// Spec 11 §3/§13, Spec 09 §4 — shared review-gate/decision-submission
// contracts, extracted verbatim out of
// apps/web-console/lib/console/types.ts so both apps/web-console (Spec 09)
// and apps/orchestrator/src/slack (Spec 11) import the SAME type
// declarations instead of one app importing the other's internal types, or
// each app redeclaring its own drifting copy.
//
// MOVED VERBATIM, NOT RE-DERIVED. If you are looking for the original
// doc-comment history behind any of these types (why TierCGateStatus has
// 5 values, why ReviewGateView is a kind-discriminated union, why
// DecisionAction includes "escalate_to_tier_c" even though
// graph-schema's ReviewDecision does not), see
// apps/web-console/lib/console/types.ts's own historical comments — this
// file intentionally does not repeat that whole history, only the type
// shapes themselves plus a short pointer.
//
// apps/web-console/lib/console/types.ts now re-exports these types from
// this package (a thin shim, kept for one release per §13's migration
// note) rather than declaring them itself.

import type { HumanReview, ObligationStatus } from "@sentinel-act/graph-schema";

// ---------------------------------------------------------------------------
// Session (application-level, not a graph node).
// ---------------------------------------------------------------------------

export type ReviewerRole =
  | "compliance_officer" // Tier B primary reviewer
  | "senior_compliance_officer" // Tier C reviewer
  | "backup_reviewer" // appears only on SLA breach reassignment
  | "compliance_head"; // read-only, Observer mode (Spec 10) — 403 on write routes

export interface ReviewerSession {
  reviewerId: string; // stable id, matches HumanReview.reviewer_id once a decision is recorded
  name: string;
  email: string;
  role: ReviewerRole;
}

// ---------------------------------------------------------------------------
// SLA state (queue + detail). Deliberately a 3-value vocabulary, distinct
// from packages/ui's UrgencyLevel per Spec 00 §7's "risk tier vs urgency
// tier" convention.
// ---------------------------------------------------------------------------

export type SlaState = "ok" | "due_soon" | "breached";

// ---------------------------------------------------------------------------
// Orchestrator's real wire review-gate contract (Spec 08 FR-24a), produced
// by apps/orchestrator/src/mastra/workflows/orchestrator.review-gate-view.ts's
// toWireReviewGateView. THE independence guarantee lives in this type:
// `reveal` on TierCReviewGateView is only ever non-null when `status`
// starts with "resolved_" — i.e. after BOTH reviewers have submitted.
// ---------------------------------------------------------------------------

export type TierCGateStatus =
  | "unclaimed" // no reviewer has claimed either slot yet (or viewer is not entitled to know more)
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
  rationaleRequired: true; // required to reject; approve is not offered at all
  existingDecision: HumanReview | null;
}

export type ReviewGateView = TierBReviewGateView | TierCReviewGateView | EscalateReviewGateView;

// ---------------------------------------------------------------------------
// Decision submission (screen 3 / sign-off panel; Spec 11's rationale
// modal submits through the same shape).
// ---------------------------------------------------------------------------

/** GAP vs the real data model, intentionally left as an extension point:
 *  the real `ReviewDecision` (graph-schema/src/nodes.ts) is exactly
 *  "approve" | "reject" — recordHumanReview rejects any other string.
 *  "escalate_to_tier_c" is a BFF-level *routing* concept (Spec 09 FR-28)
 *  that never reaches recordHumanReview/resumeOrchestratorRun as a
 *  HumanReview.decision. See apps/web-console's decisions/route.ts for
 *  the full analysis of why. Spec 11's Slack surface never offers this
 *  value from a button (FR-5 — ESCALATE cards have no decision actions at
 *  all), so it only round-trips through this shared type, unused by
 *  Slack in practice. */
export type DecisionAction = "approve" | "reject" | "escalate_to_tier_c";

export interface SubmitDecisionRequest {
  decision: DecisionAction;
  rationale: string | null; // required (non-empty, trimmed) whenever the gate requires it (Tier C / ESCALATE reject)
}

export interface SubmitDecisionResponse {
  obligationStatus: ObligationStatus;
  humanReview: HumanReview; // the fact just written — for MY OWN decision only, never the peer's
  reviewGate: ReviewGateView; // updated view, same redaction rules as GET detail apply
}
