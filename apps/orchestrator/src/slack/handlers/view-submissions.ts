// Spec 11 §11 Task 6, §6 FR-13–FR-16, FR-24. Split into a synchronous
// validation phase (FR-14 — must produce Slack's response_action:"errors"
// shape in the DIRECT HTTP response, which is only possible before the
// ack) and an async processing phase (FR-13's "ack-then-async-follow-up"
// pattern: resumeReviewStep can exceed Slack's 3-second budget under
// load, so it MUST happen after the 200 {} ack that closes the modal).
// app.ts is responsible for sequencing: call validateRationaleSubmission
// synchronously and respond with its result FIRST; only when it is valid
// does app.ts send the plain `200 {}` ack and then invoke
// processViewSubmission (not awaited before responding to Slack, though
// this module's own tests await it directly for determinism).
import type { ReviewTier } from "@sentinel-act/graph-schema";
import { buildRationaleValidationError } from "../blocks.js";
import { ResumeReviewStepError, resumeReviewStep, type ResumeReviewStepErrorCode } from "../orchestrator-client.js";
import { refreshAllCardsForObligation, sendDecisionConfirmation, type DeliveryDeps } from "../delivery.js";
import { emitReviewSubmissionTelemetry, type TelemetrySink } from "../telemetry.js";
import { extractRationaleValue, type SlackViewSubmissionPayload } from "../slack-payloads.js";
import type { SlackUserMappingStore } from "../user-mapping.js";
import type { RationaleModalMetadata } from "../types.js";

export const SUBMIT_REVIEW_DECISION_CALLBACK_ID = "submit_review_decision";

/** FR-14: rationaleRequired is a fixed property of the tier/kind (Tier B
 *  is always optional, Tier C/ESCALATE always required) — the literal
 *  `rationaleRequired` field on TierBReviewGateView/TierCReviewGateView/
 *  EscalateReviewGateView (packages/review-contracts) is `false`/`true`/
 *  `true` respectively, never instance-varying, so this can be computed
 *  synchronously from `metadata.tier` alone without a live getReviewGate
 *  call — required to keep validation inside the pre-ack response. */
export function rationaleRequiredForTier(tier: ReviewTier | "ESCALATE"): boolean {
  return tier !== "B";
}

export type RationaleValidationResult =
  | { valid: true }
  | { valid: false; response: Record<string, unknown> };

/** FR-14: Tier B empty rationale accepted; Tier C/ESCALATE empty or
 *  whitespace-only rationale rejected via `response_action: "errors"`,
 *  keeping the modal open — MUST be enforced here even though the modal
 *  UI also sets `optional: false` client-side (defense in depth, same
 *  reasoning as Spec 09 FR-25). This is the server-side check; the modal
 *  UI's own `optional` flag is a convenience only, never authoritative. */
export function validateRationaleSubmission(payload: SlackViewSubmissionPayload, tier: ReviewTier | "ESCALATE"): RationaleValidationResult {
  if (!rationaleRequiredForTier(tier)) {
    return { valid: true };
  }
  const rationale = extractRationaleValue(payload);
  if (rationale.trim().length === 0) {
    return { valid: false, response: buildRationaleValidationError("Rationale is required and must be non-empty at Tier C.") };
  }
  return { valid: true };
}

export interface ViewSubmissionHandlerDeps extends DeliveryDeps {
  userMappingStore: SlackUserMappingStore;
  telemetrySink?: TelemetrySink;
}

export interface ProcessViewSubmissionResult {
  outcome: "success" | "error";
  errorCode?: ResumeReviewStepErrorCode | "NO_MAPPING";
}

/** FR-13 (async phase), FR-16, FR-24. Callers MUST have already sent
 *  Slack's `200 {}` ack (or, on the FR-14 validation-failure path, never
 *  call this function at all — that path terminates at
 *  validateRationaleSubmission's response). */
export async function processViewSubmission(
  payload: SlackViewSubmissionPayload,
  deps: ViewSubmissionHandlerDeps
): Promise<ProcessViewSubmissionResult> {
  const start = Date.now();
  const metadata = JSON.parse(payload.view.private_metadata) as RationaleModalMetadata;

  // NFR-Security-3: reviewerId is ALWAYS resolved server-side from the
  // verified payload.user.id via SlackUserMapping — private_metadata
  // never carries a reviewerId, so there is nothing to trust/mistrust
  // from the client here.
  const mapping = deps.userMappingStore.findBySlackUserId(payload.user.id);
  if (!mapping) {
    return { outcome: "error", errorCode: "NO_MAPPING" };
  }
  const reviewerId = mapping.reviewerId;

  const rationaleRaw = extractRationaleValue(payload);
  const rationale = rationaleRaw.trim().length > 0 ? rationaleRaw : null;
  const sourceRef = JSON.stringify({ channel: metadata.slackChannel, message_ts: metadata.messageTs, user_id: payload.user.id });

  try {
    const result = await resumeReviewStep({
      obligationId: metadata.obligationId,
      reviewerId,
      tier: metadata.tier,
      decision: metadata.decision,
      rationale,
      sourceRef
    });

    const latencyMs = Date.now() - start;
    // FR-24(b): separate ReviewSubmissionTelemetryEvent, never touching
    // the graph write above (Fix 1 — see telemetry.ts's own doc comment).
    await emitReviewSubmissionTelemetry(
      {
        obligationId: metadata.obligationId,
        reviewerId,
        tier: metadata.tier === "ESCALATE" || metadata.tier === "C" ? "C" : "B",
        decision: metadata.decision,
        workflowState: result.workflowState,
        latencyMs,
        submittedVia: "slack"
      },
      deps.telemetrySink
    );

    // FR-16: replace the actions block with a static confirmation.
    if (metadata.tier === "B") {
      const copy = metadata.decision === "approve" ? "Your approval has been recorded." : "Your decline has been recorded.";
      await sendDecisionConfirmation(metadata.obligationId, reviewerId, metadata.decision, copy, deps);
    } else {
      // Tier C / ESCALATE (routed as C): refresh every recipient this
      // unit has sent a card to — the submitter's own card naturally
      // renders "recorded and locked, awaiting a second independent
      // review" (FR-10) via buildReviewCard's tierCContextNote, and once
      // both have submitted every recipient's card renders the reveal
      // (FR-11) — same mechanism, no special-casing needed here.
      await refreshAllCardsForObligation(metadata.obligationId, deps);
    }

    return { outcome: "success" };
  } catch (err) {
    if (err instanceof ResumeReviewStepError) {
      // §8: "resumeReviewStep times out... MUST re-query getReviewGate to
      // learn the actual resulting state and reflect that" — refresh from
      // current truth rather than leaving a stale/confusing card.
      await refreshAllCardsForObligation(metadata.obligationId, deps).catch(() => undefined);
      return { outcome: "error", errorCode: err.code };
    }
    throw err;
  }
}
