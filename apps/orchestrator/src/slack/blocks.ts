// Spec 11 §5.4, §6 FR-1/FR-3/FR-5, §11 Task 4 — Block Kit card builders:
// the Tier B/C actionable card, the ESCALATE link-only card, the
// rationale modal, and the reveal/confirmation/slot-filled render states
// (FR-9–FR-11, FR-16).
import type { ReviewTier } from "@sentinel-act/graph-schema";
import type { SlaState } from "@sentinel-act/review-contracts";
import type { RationaleModalMetadata, SlackCardModel } from "./types.js";

// ---------------------------------------------------------------------------
// FR-3: tier badge emoji+text mapping, consistent with the console's
// RiskTierBadge token colors (Spec 00 §7: --risk-a green, --risk-b amber,
// --risk-c orange, --risk-escalate red). A named constant, not inlined
// per-callsite.
// ---------------------------------------------------------------------------

export const SLACK_TIER_EMOJI: Record<ReviewTier | "ESCALATE", string> = {
  A: "🟢", // never sent to Slack per FR-4/FR-1's scope — listed for completeness
  B: "🟡",
  C: "🟠",
  ESCALATE: "🔴"
};

function tierLabel(tier: ReviewTier | "ESCALATE"): string {
  return tier === "ESCALATE" ? "ESCALATE" : `Tier ${tier}`;
}

// ---------------------------------------------------------------------------
// SLA countdown rendering (FR-1: "rendered as a relative countdown").
// ---------------------------------------------------------------------------

export function formatSlaCountdown(slaDueAt: string | null, slaState: SlaState, nowMs: number = Date.now()): string {
  if (!slaDueAt) {
    return "No review SLA set";
  }
  const dueMs = new Date(slaDueAt).getTime();
  const diffMs = dueMs - nowMs;
  if (slaState === "breached" || diffMs <= 0) {
    const overdueMs = Math.abs(diffMs);
    return `⏱ Overdue by ${formatDuration(overdueMs)}`;
  }
  const prefix = slaState === "due_soon" ? "⏰ Due soon —" : "⏱";
  return `${prefix} Due in ${formatDuration(diffMs)}`;
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) {
    return `${minutes}m`;
  }
  return `${hours}h ${minutes}m`;
}

// ---------------------------------------------------------------------------
// Shared header/fields/context blocks (FR-1's exact field set).
// ---------------------------------------------------------------------------

type SlackBlock = Record<string, unknown>;

function headerBlock(model: SlackCardModel, headerText: string): SlackBlock {
  return { type: "header", text: { type: "plain_text", text: `${SLACK_TIER_EMOJI[model.tier]} ${headerText}` } };
}

function summarySectionBlock(model: SlackCardModel): SlackBlock {
  return {
    type: "section",
    text: { type: "mrkdwn", text: `*${model.circularTitle}*\n${model.summary}` }
  };
}

function scoreFieldsBlock(model: SlackCardModel): SlackBlock {
  const fields = [
    { type: "mrkdwn", text: `*Confidence*\n${model.confidenceScore.toFixed(2)}` },
    { type: "mrkdwn", text: `*Grounding*\n${model.groundingScore.toFixed(2)}` },
    { type: "mrkdwn", text: `*Risk score*\n${model.riskScore.toFixed(2)}` },
    { type: "mrkdwn", text: `*Why ${tierLabel(model.tier)}*\n${model.topTierReason ?? "(no reason available)"}` }
  ];
  return { type: "section", fields };
}

function escalationLineBlock(model: SlackCardModel): SlackBlock | null {
  if (model.escalationReason === null) {
    return null;
  }
  return { type: "context", elements: [{ type: "mrkdwn", text: `🚨 ${model.escalationReason}` }] };
}

function slaContextBlock(model: SlackCardModel, extra: string | null, nowMs?: number): SlackBlock {
  const countdown = formatSlaCountdown(model.slaDueAt, model.slaState, nowMs);
  const text = extra ? `${countdown} · ${extra}` : countdown;
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

function openConsoleButton(model: SlackCardModel, label = "Open full detail →"): SlackBlock {
  return {
    type: "button",
    action_id: "open_console",
    text: { type: "plain_text", text: label },
    url: model.consoleDetailUrl
  };
}

// ---------------------------------------------------------------------------
// FR-5, §5.4: ESCALATE link-only card. NO approve/decline action anywhere
// in the actions block — not disabled, not hidden, absent. This is the
// direct target of Fix 2's regression test.
// ---------------------------------------------------------------------------

export function buildEscalateCard(model: SlackCardModel): { blocks: SlackBlock[]; text: string } {
  const blocks: SlackBlock[] = [
    headerBlock(model, "Contradiction flagged — review in console"),
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${model.circularTitle}* — ${model.escalationReason ?? "requires full side-by-side review"}. This requires the full side-by-side view and cannot be actioned from Slack.`
      }
    },
    { type: "actions", block_id: "review_actions", elements: [openConsoleButton(model, "Open in console →")] }
  ];
  return { blocks, text: `${SLACK_TIER_EMOJI.ESCALATE} Contradiction flagged: ${model.circularTitle}` };
}

// ---------------------------------------------------------------------------
// Tier B/C actionable card actions block — varies by reviewGate state.
// ---------------------------------------------------------------------------

function actionsBlockFor(model: SlackCardModel): SlackBlock | null {
  const gate = model.reviewGate;

  if (gate.kind === "tier_b") {
    if (gate.existingDecision !== null) {
      return null; // FR-16: decided -> no clickable buttons remain.
    }
    return {
      type: "actions",
      block_id: "review_actions",
      elements: [
        {
          type: "button",
          action_id: "approve",
          style: "primary",
          text: { type: "plain_text", text: "Approve" },
          value: JSON.stringify({ obligationId: model.obligationId, decision: "approve" })
        },
        {
          type: "button",
          action_id: "decline",
          style: "danger",
          text: { type: "plain_text", text: "Decline" },
          value: JSON.stringify({ obligationId: model.obligationId, decision: "reject" })
        },
        openConsoleButton(model)
      ]
    };
  }

  if (gate.kind === "escalate") {
    // Unreachable at runtime — buildReviewCard dispatches tier === "ESCALATE"
    // to buildEscalateCard before actionsBlockFor is ever called (FR-5).
    // Handled explicitly here only so TypeScript's discriminated-union
    // narrowing below is exhaustive; never actually exercised.
    return null;
  }

  // tier_c
  if (gate.status === "resolved_agree" || gate.status === "resolved_disagree") {
    return null; // FR-11 reveal state — no actions.
  }
  if (gate.status === "viewer_submitted_awaiting_peer") {
    return null; // FR-10 — recorded and locked, awaiting peer.
  }
  if (model.otherSlotFilled && gate.viewerSlot === null) {
    // FR-9: the bare fact "a slot is no longer open" — this viewer may
    // still claim/decide the remaining slot, so Approve/Decline remain
    // available; only the language differs (rendered in the context line,
    // not the actions block, since this viewer can still act).
    return {
      type: "actions",
      block_id: "review_actions",
      elements: [
        {
          type: "button",
          action_id: "approve",
          style: "primary",
          text: { type: "plain_text", text: "Approve" },
          value: JSON.stringify({ obligationId: model.obligationId, decision: "approve" })
        },
        {
          type: "button",
          action_id: "decline",
          style: "danger",
          text: { type: "plain_text", text: "Decline" },
          value: JSON.stringify({ obligationId: model.obligationId, decision: "reject" })
        },
        openConsoleButton(model)
      ]
    };
  }
  // unclaimed or claimed_by_viewer, not yet decided.
  return {
    type: "actions",
    block_id: "review_actions",
    elements: [
      {
        type: "button",
        action_id: "approve",
        style: "primary",
        text: { type: "plain_text", text: "Approve" },
        value: JSON.stringify({ obligationId: model.obligationId, decision: "approve" })
      },
      {
        type: "button",
        action_id: "decline",
        style: "danger",
        text: { type: "plain_text", text: "Decline" },
        value: JSON.stringify({ obligationId: model.obligationId, decision: "reject" })
      },
      openConsoleButton(model)
    ]
  };
}

function tierCContextNote(model: SlackCardModel): string | null {
  const gate = model.reviewGate;
  if (gate.kind !== "tier_c") {
    return null;
  }
  switch (gate.status) {
    case "claimed_by_viewer":
      return "claimed as " + (gate.viewerSlot ?? "reviewer") + " · not yet decided";
    case "viewer_submitted_awaiting_peer":
      return "recorded and locked, awaiting a second independent review";
    case "resolved_agree":
      return "both reviews recorded — resolved";
    case "resolved_disagree":
      return "both reviews recorded — escalated (disagreement)";
    case "unclaimed":
    default:
      return model.otherSlotFilled ? "a slot is no longer open — you may still be needed for the other slot" : "not yet claimed";
  }
}

/** Tier B/C actionable card (§5.4 first example) or ESCALATE link-only
 *  card (§5.4 second example, delegated to buildEscalateCard) — FR-4:
 *  Tier A items MUST NEVER be delivered to Slack, enforced by the caller
 *  (delivery.ts), not re-checked here since this is a pure render
 *  function with no side effects to guard. */
export function buildReviewCard(model: SlackCardModel, nowMs?: number): { blocks: SlackBlock[]; text: string } {
  if (model.tier === "ESCALATE") {
    return buildEscalateCard(model);
  }

  const headerText = `${tierLabel(model.tier)} review — ${model.circularTitle}`;
  const blocks: SlackBlock[] = [headerBlock(model, `${tierLabel(model.tier)} review — SEBI Circular update`), summarySectionBlock(model), scoreFieldsBlock(model)];

  const escalationLine = escalationLineBlock(model);
  if (escalationLine) {
    blocks.push(escalationLine);
  }

  blocks.push(slaContextBlock(model, tierCContextNote(model), nowMs));

  const actions = actionsBlockFor(model);
  if (actions) {
    blocks.push(actions);
  } else {
    blocks.push({ type: "actions", block_id: "review_actions", elements: [openConsoleButton(model)] });
  }

  return { blocks, text: `${SLACK_TIER_EMOJI[model.tier]} ${headerText}` };
}

// ---------------------------------------------------------------------------
// FR-9 (other reviewer's card, slot filled by peer, this viewer has not
// claimed either): re-rendered actions block with a single "Claim"-style
// button removed / replaced — bare fact only, no identity/decision leak.
// Distinct from buildReviewCard's normal path above (which still shows
// Approve/Decline for a viewer with an open slot) — this is the wording
// this unit uses when a caller wants to explicitly announce a claim event
// without the viewer clicking anything, mirroring FR-9's exact language.
// ---------------------------------------------------------------------------

export function buildSlotFilledAnnouncementCard(model: SlackCardModel, nowMs?: number): { blocks: SlackBlock[]; text: string } {
  const built = buildReviewCard({ ...model, otherSlotFilled: true }, nowMs);
  return built;
}

// ---------------------------------------------------------------------------
// FR-17: due-soon reminder — same card, refreshed countdown + a distinct
// "⏰ Reminder" context line, rendered via chat.update on the EXISTING
// message (never a brand-new one, to avoid fragmenting one obligation
// across multiple Slack messages in the same DM).
// ---------------------------------------------------------------------------

export function buildReviewCardWithReminder(model: SlackCardModel, nowMs?: number): { blocks: SlackBlock[]; text: string } {
  const built = buildReviewCard(model, nowMs);
  const reminderBlock: SlackBlock = { type: "context", elements: [{ type: "mrkdwn", text: "⏰ Reminder — this review is still pending" }] };
  // Insert right after the header/summary/fields, before the SLA context
  // block, so the reminder reads as "why you're seeing this update" —
  // blocks[0..2] are header/summary/fields for both the actionable and
  // ESCALATE card shapes.
  const blocks = [...built.blocks.slice(0, 3), reminderBlock, ...built.blocks.slice(3)];
  return { blocks, text: `⏰ Reminder: ${built.text}` };
}

// ---------------------------------------------------------------------------
// FR-19(a): the previous reviewer's card once SLA is breached and the
// item is reassigned — no actions, a clear "reassigned" state.
// ---------------------------------------------------------------------------

export function buildBreachedReassignmentCard(model: SlackCardModel, nowMs?: number): { blocks: SlackBlock[]; text: string } {
  const headerText = `${tierLabel(model.tier)} review — ${model.circularTitle}`;
  const blocks: SlackBlock[] = [
    headerBlock(model, `${tierLabel(model.tier)} review — reassigned`),
    summarySectionBlock(model),
    { type: "section", text: { type: "mrkdwn", text: "*Reassigned — SLA missed.* This item has been handed to a backup reviewer; you can no longer act on it here." } },
    slaContextBlock(model, null, nowMs),
    { type: "actions", block_id: "review_actions", elements: [openConsoleButton(model)] }
  ];
  return { blocks, text: `${SLACK_TIER_EMOJI[model.tier]} ${headerText} — reassigned, SLA missed` };
}

// ---------------------------------------------------------------------------
// FR-16: static confirmation after a successful decision, buttons removed.
// ---------------------------------------------------------------------------

export function buildConfirmationCard(
  model: SlackCardModel,
  decision: "approve" | "reject",
  copy: string,
  nowMs?: number
): { blocks: SlackBlock[]; text: string } {
  const headerText = `${tierLabel(model.tier)} review — ${model.circularTitle}`;
  const blocks: SlackBlock[] = [
    headerBlock(model, `${tierLabel(model.tier)} review — SEBI Circular update`),
    summarySectionBlock(model),
    scoreFieldsBlock(model),
    { type: "section", text: { type: "mrkdwn", text: `*Decision recorded:* ${decision === "approve" ? "Approve" : "Decline"}\n${copy}` } },
    slaContextBlock(model, null, nowMs),
    { type: "actions", block_id: "review_actions", elements: [openConsoleButton(model)] }
  ];
  return { blocks, text: `${SLACK_TIER_EMOJI[model.tier]} ${headerText} — decided` };
}

// ---------------------------------------------------------------------------
// §5.4 Rationale modal (FR-12–FR-15).
// ---------------------------------------------------------------------------

export interface BuildRationaleModalInput {
  obligationId: string;
  circularTitle: string;
  decision: "approve" | "reject";
  tier: ReviewTier | "ESCALATE";
  rationaleRequired: boolean;
  slackChannel: string;
  messageTs: string;
  /** When re-rendering after a validation error (FR-14), preserves what
   *  the reviewer already typed. */
  previousRationaleValue?: string;
}

/** private_metadata carries obligationId/decision/tier/slackChannel/
 *  messageTs ONLY — NEVER reviewerId (NFR-Security-3): reviewerId is
 *  always resolved server-side from payload.user.id via
 *  SlackUserMapping. */
export function buildRationaleModal(input: BuildRationaleModalInput): Record<string, unknown> {
  const metadata: RationaleModalMetadata = {
    obligationId: input.obligationId,
    decision: input.decision,
    tier: input.tier,
    slackChannel: input.slackChannel,
    messageTs: input.messageTs
  };

  const decisionLabel = input.decision === "approve" ? "Approve" : "Decline";
  const rationaleLabel = input.rationaleRequired ? "Rationale (required for Tier C)" : "Rationale (optional)";

  return {
    type: "modal",
    callback_id: "submit_review_decision",
    private_metadata: JSON.stringify(metadata),
    title: { type: "plain_text", text: `${decisionLabel} review` },
    submit: { type: "plain_text", text: "Submit" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*${input.circularTitle}*\nDecision: *${decisionLabel}*` }
      },
      {
        type: "input",
        block_id: "rationale_block",
        optional: !input.rationaleRequired,
        label: { type: "plain_text", text: rationaleLabel },
        element: {
          type: "plain_text_input",
          action_id: "rationale_input",
          multiline: true,
          initial_value: input.previousRationaleValue ?? undefined
        }
      }
    ]
  };
}

/** FR-14: re-render the modal in-place with an inline validation error on
 *  rationale_block, via views.update's response_action:"errors" shape
 *  (used by the view_submission handler, not views.open). */
export function buildRationaleValidationError(errorMessage: string): Record<string, unknown> {
  return {
    response_action: "errors",
    errors: { rationale_block: errorMessage }
  };
}
