// Spec 11 §11 Task 5, §6 FR-9/FR-12. Signature verification and
// idempotency happen in app.ts BEFORE this handler is ever invoked (§6
// FR-22/FR-23: "verification MUST run before the raw body is parsed... on
// every request, no exceptions"); this module assumes it is only ever
// called with an already-authenticated, already-deduped payload.
import { buildRationaleModal } from "../blocks.js";
import { claimReviewSlot, getReviewGate } from "../orchestrator-client.js";
import { openView } from "../slack-client.js";
import { refreshAllCardsForObligation, type DeliveryDeps } from "../delivery.js";
import type { SlackUserMappingStore } from "../user-mapping.js";
import type { SlackBlockActionsPayload } from "../slack-payloads.js";
import type { RationaleModalMetadata } from "../types.js";

export class ActionNotAllowedForTierError extends Error {
  readonly code = "ACTION_NOT_ALLOWED_FOR_TIER" as const;
}

export interface BlockActionsHandlerDeps extends DeliveryDeps {
  userMappingStore: SlackUserMappingStore;
}

export interface BlockActionsHandlerResult {
  outcome: "modal_opened" | "no_op" | "action_not_allowed" | "no_slot_available" | "no_mapping" | "trigger_expired";
}

/** FR-12: on receiving a block_actions payload for approve/decline, calls
 *  views.open using payload.trigger_id within the 3-second window — the
 *  ONLY Slack API call this function makes before that (claimReviewSlot,
 *  for Tier C) is a fast in-process Orchestrator call, not a queued/
 *  background job, keeping this function's total latency inside
 *  NFR-Perf-1's 2.5s p95 budget. FR-9: claims the Tier C slot before
 *  opening the modal, then (after the modal is opened, so it never
 *  competes for the trigger_id window) refreshes every other recipient's
 *  card to reflect "a slot is no longer open" via
 *  refreshAllCardsForObligation.
 *
 *  FR-5's 403 rejection: a crafted decision:"approve" action payload for
 *  a stale-cached ESCALATE card is rejected with ACTION_NOT_ALLOWED_FOR_TIER
 *  BEFORE any claim/modal-open call — thrown, not silently ignored, so
 *  the caller (app.ts) can log it distinctly from a normal no_op. */
export async function handleBlockActionsPayload(
  payload: SlackBlockActionsPayload,
  deps: BlockActionsHandlerDeps
): Promise<BlockActionsHandlerResult> {
  const action = payload.actions[0];
  if (!action) {
    return { outcome: "no_op" };
  }

  if (action.action_id === "open_console") {
    // URL button — Slack still POSTs a block_actions notification for it,
    // but no server-side action is required beyond acking.
    return { outcome: "no_op" };
  }

  if (action.action_id !== "approve" && action.action_id !== "decline") {
    return { outcome: "no_op" };
  }

  const mapping = deps.userMappingStore.findBySlackUserId(payload.user.id);
  if (!mapping) {
    return { outcome: "no_mapping" };
  }
  const reviewerId = mapping.reviewerId;

  const value = action.value ? (JSON.parse(action.value) as { obligationId: string; decision: "approve" | "reject" }) : null;
  if (!value) {
    return { outcome: "no_op" };
  }

  const staticFields = deps.store.getStaticFields(value.obligationId);
  const tier = staticFields?.tier ?? "B";

  // FR-5: ESCALATE items never render approve/decline buttons (Fix 2), so
  // reaching here for tier === "ESCALATE" only happens via a crafted/stale
  // payload — reject with the same semantics Spec 09 uses for a
  // server-side ACTION_NOT_ALLOWED_FOR_TIER violation.
  if (tier === "ESCALATE") {
    throw new ActionNotAllowedForTierError(
      `decision action "${action.action_id}" is not allowed for an ESCALATE-tier obligation (${value.obligationId}).`
    );
  }

  const wireTier: "B" | "C" = tier === "C" ? "C" : "B";
  let rationaleRequired = wireTier === "C";

  if (wireTier === "C") {
    const claimResult = await claimReviewSlot(value.obligationId, reviewerId);
    if (!claimResult.ok) {
      // Could be a genuine "both slots taken by someone else", or an
      // idempotent retry by a reviewer who already holds a slot — check
      // the reviewer's own gate before giving up (§8's concurrent-claim
      // row: the losing surface shows ALREADY_CLAIMED_BY_SELF, not a
      // hard failure, when the caller already holds a slot).
      const gate = await getReviewGate(value.obligationId, reviewerId, "C");
      const alreadyHoldsSlot = gate.kind === "tier_c" && gate.viewerSlot !== null;
      if (!alreadyHoldsSlot) {
        return { outcome: "no_slot_available" };
      }
    }
    // FR-9: announce to every OTHER recipient that a slot is no longer
    // open. Deliberately awaited before returning so tests can assert on
    // it deterministically; a production deployment may choose to run
    // this without awaiting since it happens strictly after the
    // trigger_id-bound views.open call below.
  }

  const gateForRationale = await getReviewGate(value.obligationId, reviewerId, wireTier);
  rationaleRequired = gateForRationale.rationaleRequired;

  const container = payload.container ?? { channel_id: payload.channel?.id, message_ts: payload.message?.ts };
  const slackChannel = container.channel_id ?? "";
  const messageTs = container.message_ts ?? "";

  const modal = buildRationaleModal({
    obligationId: value.obligationId,
    circularTitle: staticFields?.circularTitle ?? value.obligationId,
    decision: value.decision,
    tier,
    rationaleRequired,
    slackChannel,
    messageTs
  } satisfies Omit<RationaleModalMetadata, never> & { circularTitle: string; rationaleRequired: boolean });

  const openResult = await openView({ botToken: deps.botToken, triggerId: payload.trigger_id, view: modal, fetchImpl: deps.fetchImpl });
  if (!openResult.ok) {
    if (openResult.error === "expired_trigger_id") {
      return { outcome: "trigger_expired" };
    }
    return { outcome: "no_op" };
  }

  if (wireTier === "C") {
    await refreshAllCardsForObligation(value.obligationId, deps);
  }

  return { outcome: "modal_opened" };
}
