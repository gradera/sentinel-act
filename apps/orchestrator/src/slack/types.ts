// Spec 11 §4 (third code block) — types local to this unit, NOT part of
// packages/review-contracts (that package only carries types shared with
// apps/web-console; SlackCardModel/SentTierCCard/SlackUserMapping are
// Slack-delivery-only concerns with no console equivalent).
import type { ReviewTier } from "@sentinel-act/graph-schema";
import type { ReviewGateView, SlaState } from "@sentinel-act/review-contracts";

/** Static, admin-managed mapping. No self-service UI in this build —
 *  provisioned via a seed script / config table (§13). */
export interface SlackUserMapping {
  reviewerId: string; // matches ReviewerSession.reviewerId / HumanReview.reviewer_id
  slackUserId: string; // Slack's "U..." id, resolved once at mapping time
  slackTeamId: string; // supports single-workspace deployment; see §13
}

/** The minimal projection of ObligationDetailResponse (Spec 09 §4) this
 *  unit needs to render a card. Built server-side by
 *  card-model.ts's assembleSlackCardModel, which calls
 *  getReviewGate(obligationId, reviewerId) (§5.3, FR-6) for the SPECIFIC
 *  recipient — never a single shared computation reused across
 *  recipients. */
export interface SlackCardModel {
  obligationId: string;
  circularTitle: string;
  category: string;
  summary: string; // identical derivation to QueueItemSummary.summary (Spec 09 FR-2 / deriveQueueSummary)
  tier: ReviewTier | "ESCALATE";
  topTierReason: string | null; // tierReasons[0], or null if unavailable
  confidenceScore: number;
  groundingScore: number;
  riskScore: number;
  slaDueAt: string | null;
  slaState: SlaState;
  escalationReason: string | null;
  reviewGate: ReviewGateView; // per-recipient — computed with THIS recipient's reviewerId (§6, FR-6)
  consoleDetailUrl: string; // `${WEB_CONSOLE_BASE_URL}/queue/${obligationId}`
  /** Slack-rendering-only signal, Tier C only: true when this recipient
   *  has not claimed a slot themselves (reviewGate.viewerSlot === null)
   *  but the OTHER slot has already been claimed by someone else — drives
   *  FR-9's "a slot is no longer open" card update. Deliberately NOT part
   *  of the shared ReviewGateView type (packages/review-contracts) since
   *  it is derived from raw claim-slot occupancy, a concept the console
   *  surfaces differently (TierCViewerQueueState); computed locally by
   *  card-model.ts from the same claim-slots read getReviewGate already
   *  performs, never a second independent redaction path. Always false
   *  for Tier B / ESCALATE. */
  otherSlotFilled: boolean;
}

export interface SentTierCCard {
  obligationId: string;
  reviewerId: string;
  slackChannel: string; // DM channel id (opens as "D...")
  messageTs: string; // needed for later chat.update calls — stored per (obligationId, reviewerId)
}

/** Slack's standard interactivity envelope kinds this unit handles (§5.1).
 *  `view_closed` is accepted (deduped, acked) but never acted on — Slack
 *  sends it when a reviewer dismisses the modal without submitting; no
 *  state change is needed. */
export type SlackInteractionType = "block_actions" | "view_submission" | "view_closed";

export interface SlackBlockActionValue {
  obligationId: string;
  decision: "approve" | "reject";
}

/** private_metadata payload (§5.4, §6 FR-15). Deliberately carries
 *  obligationId/decision/tier ONLY — never reviewerId (NFR-Security-3):
 *  reviewerId is always resolved server-side from the verified
 *  payload.user.id via SlackUserMapping, never taken from a
 *  client-controllable field. */
export interface RationaleModalMetadata {
  obligationId: string;
  decision: "approve" | "reject";
  tier: ReviewTier | "ESCALATE";
  /** The channel + messageTs of the card that triggered this modal, so
   *  the view_submission handler can chat.update the right message
   *  without a second SentTierCCard lookup (defense against a race where
   *  the lookup table is updated between the click and the submission). */
  slackChannel: string;
  messageTs: string;
}
