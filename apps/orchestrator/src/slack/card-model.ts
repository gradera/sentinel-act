// Spec 11 §4 SlackCardModel assembly, §6 FR-6. Builds the per-recipient
// card model by calling getReviewGate(obligationId, reviewerId) for THIS
// specific Slack user — never a single shared computation reused across
// recipients (same "per-caller, never shared/cached" rule as Spec 09
// FR-18, applied at message-construction time).
import type { ReviewTier } from "@sentinel-act/graph-schema";
import type { SlaState } from "@sentinel-act/review-contracts";
import { deriveQueueSummary } from "@sentinel-act/review-contracts";
import { getClaimSlots, getReviewGate } from "./orchestrator-client.js";
import type { SlackCardModel } from "./types.js";

export interface AssembleSlackCardModelInput {
  obligationId: string;
  reviewerId: string;
  circularTitle: string;
  category: string;
  requirementText: string;
  tier: ReviewTier | "ESCALATE";
  tierReasons: string[];
  confidenceScore: number;
  groundingScore: number;
  riskScore: number;
  slaDueAt: string | null;
  slaState: SlaState;
  escalationReason: string | null;
  webConsoleBaseUrl: string;
}

export async function assembleSlackCardModel(input: AssembleSlackCardModelInput): Promise<SlackCardModel> {
  const wireTier: "B" | "C" | "ESCALATE" = input.tier === "A" ? "B" : (input.tier as "B" | "C" | "ESCALATE");
  const reviewGate = await getReviewGate(input.obligationId, input.reviewerId, wireTier);

  let otherSlotFilled = false;
  if (input.tier === "C" && reviewGate.kind === "tier_c" && reviewGate.viewerSlot === null) {
    const slots = await getClaimSlots(input.obligationId);
    otherSlotFilled = Boolean(slots && (slots.maker || slots.checker));
  }

  return {
    obligationId: input.obligationId,
    circularTitle: input.circularTitle,
    category: input.category,
    summary: deriveQueueSummary(input.requirementText),
    tier: input.tier,
    topTierReason: input.tierReasons[0] ?? null,
    confidenceScore: input.confidenceScore,
    groundingScore: input.groundingScore,
    riskScore: input.riskScore,
    slaDueAt: input.slaDueAt,
    slaState: input.slaState,
    escalationReason: input.escalationReason,
    reviewGate,
    consoleDetailUrl: `${input.webConsoleBaseUrl}/queue/${input.obligationId}`,
    otherSlotFilled
  };
}
