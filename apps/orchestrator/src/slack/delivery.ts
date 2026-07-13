// Spec 11 §11 Task 8 (highest-risk task in this unit) — Tier C per-reviewer
// fan-out delivery with independent messageTs tracking (SentTierCCard,
// FR-7–FR-11), plus the single-recipient delivery path Tier B/ESCALATE
// use. NFR-Security-1's peer-decision-field-absence guarantee is a
// property of THIS module: every outbound chat.postMessage/chat.update
// call is built from a card model computed by a per-recipient
// getReviewGate call (card-model.ts), never a value copied from another
// recipient's model or store entry.
import type { ReviewTier } from "@sentinel-act/graph-schema";
import type { SlaState } from "@sentinel-act/review-contracts";
import { assembleSlackCardModel } from "./card-model.js";
import { buildConfirmationCard, buildReviewCard } from "./blocks.js";
import { postMessage, updateMessage } from "./slack-client.js";
import { resolveDmChannel, type DmChannelCache, type SlackUserMappingStore } from "./user-mapping.js";
import type { SentTierCCard } from "./types.js";

/** Obligation-level fields that do NOT vary by recipient — cached once
 *  per obligationId so a later refresh (FR-9 claim update, FR-11 reveal)
 *  only needs to redo the per-recipient getReviewGate call, never a
 *  second read of the obligation's static fields (which would risk two
 *  recipients being rendered from two different snapshots of the same
 *  static data — a correctness concern distinct from, but adjacent to,
 *  NFR-Security-1's redaction concern). */
export interface CardStaticFields {
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
}

function entryKey(obligationId: string, reviewerId: string): string {
  return `${obligationId}:${reviewerId}`;
}

/** In-memory store of every card this unit has sent, keyed per
 *  (obligationId, reviewerId) — FR-8's guarantee: no code path in this
 *  module reads one recipient's stored messageTs to update another
 *  recipient's message; `listForObligation` returns entries so callers
 *  can iterate and update EACH ONE with ITS OWN freshly-computed model. */
export class SentCardStore {
  private readonly entries = new Map<string, SentTierCCard>();
  private readonly staticFieldsByObligation = new Map<string, CardStaticFields>();

  setStaticFields(obligationId: string, fields: CardStaticFields): void {
    this.staticFieldsByObligation.set(obligationId, fields);
  }

  getStaticFields(obligationId: string): CardStaticFields | null {
    return this.staticFieldsByObligation.get(obligationId) ?? null;
  }

  record(entry: SentTierCCard): void {
    this.entries.set(entryKey(entry.obligationId, entry.reviewerId), entry);
  }

  get(obligationId: string, reviewerId: string): SentTierCCard | null {
    return this.entries.get(entryKey(obligationId, reviewerId)) ?? null;
  }

  listForObligation(obligationId: string): SentTierCCard[] {
    return Array.from(this.entries.values()).filter((e) => e.obligationId === obligationId);
  }
}

export interface DeliveryDeps {
  botToken: string;
  webConsoleBaseUrl: string;
  store: SentCardStore;
  userMappingStore: SlackUserMappingStore;
  dmCache: DmChannelCache;
  fetchImpl?: typeof fetch;
}

/** FR-1–FR-6: delivers (or, if a message already exists for this
 *  recipient, refreshes) a single recipient's card, built from a
 *  per-recipient getReviewGate call (card-model.ts). Returns null (never
 *  throws) when the recipient has no SlackUserMapping or DM resolution
 *  fails — §8's "skip delivery for that reviewer, log a warning, item
 *  remains fully actionable via console" row; this function's caller is
 *  responsible for logging, this function just reports the outcome. */
export interface DeliverCardResult {
  delivered: boolean;
  reason?: "no_slack_mapping" | "dm_resolution_failed" | "slack_api_error";
}

export async function deliverOrRefreshCard(obligationId: string, reviewerId: string, deps: DeliveryDeps): Promise<DeliverCardResult> {
  const staticFields = deps.store.getStaticFields(obligationId);
  if (!staticFields) {
    throw new Error(`deliverOrRefreshCard: no static fields recorded for obligation ${obligationId} — call recordObligationForDelivery first.`);
  }

  const mapping = deps.userMappingStore.findByReviewerId(reviewerId);
  if (!mapping) {
    return { delivered: false, reason: "no_slack_mapping" };
  }

  const channelId = await resolveDmChannel(mapping.slackUserId, { botToken: deps.botToken, cache: deps.dmCache, fetchImpl: deps.fetchImpl });
  if (!channelId) {
    return { delivered: false, reason: "dm_resolution_failed" };
  }

  const model = await assembleSlackCardModel({
    obligationId,
    reviewerId,
    circularTitle: staticFields.circularTitle,
    category: staticFields.category,
    requirementText: staticFields.requirementText,
    tier: staticFields.tier,
    tierReasons: staticFields.tierReasons,
    confidenceScore: staticFields.confidenceScore,
    groundingScore: staticFields.groundingScore,
    riskScore: staticFields.riskScore,
    slaDueAt: staticFields.slaDueAt,
    slaState: staticFields.slaState,
    escalationReason: staticFields.escalationReason,
    webConsoleBaseUrl: deps.webConsoleBaseUrl
  });

  const { blocks, text } = buildReviewCard(model);
  const existing = deps.store.get(obligationId, reviewerId);

  if (existing) {
    const result = await updateMessage({ botToken: deps.botToken, channel: existing.slackChannel, ts: existing.messageTs, blocks, text, fetchImpl: deps.fetchImpl });
    if (!result.ok) {
      return { delivered: false, reason: "slack_api_error" };
    }
    return { delivered: true };
  }

  const result = await postMessage({ botToken: deps.botToken, channel: channelId, blocks, text, fetchImpl: deps.fetchImpl });
  if (!result.ok || !result.ts) {
    return { delivered: false, reason: "slack_api_error" };
  }
  deps.store.record({ obligationId, reviewerId, slackChannel: channelId, messageTs: result.ts });
  return { delivered: true };
}

/** FR-7: one independent DM per eligible reviewer, never a shared
 *  message. Caches static obligation fields once, then delivers each
 *  recipient independently in sequence (NFR-RateLimit-1: sequential,
 *  not parallel-blasted, to stay within Slack's ~1 req/s sustained
 *  budget for chat.postMessage on a standard app). */
export async function deliverTierCFanOut(
  obligationId: string,
  eligibleReviewerIds: string[],
  staticFields: CardStaticFields,
  deps: DeliveryDeps
): Promise<Record<string, DeliverCardResult>> {
  deps.store.setStaticFields(obligationId, staticFields);
  const results: Record<string, DeliverCardResult> = {};
  for (const reviewerId of eligibleReviewerIds) {
    results[reviewerId] = await deliverOrRefreshCard(obligationId, reviewerId, deps);
  }
  return results;
}

/** Single-recipient delivery (Tier B, or an ESCALATE notification —
 *  FR-4/FR-5 both single-target cases). */
export async function deliverSingleRecipientCard(
  obligationId: string,
  reviewerId: string,
  staticFields: CardStaticFields,
  deps: DeliveryDeps
): Promise<DeliverCardResult> {
  deps.store.setStaticFields(obligationId, staticFields);
  return deliverOrRefreshCard(obligationId, reviewerId, deps);
}

/** FR-9/FR-11: refreshes EVERY recipient this unit has ever sent a card
 *  to for this obligation, each from ITS OWN freshly-computed
 *  per-recipient reviewGate — the single mechanism this unit uses for
 *  both "a slot was claimed" (FR-9: every other recipient's card updates
 *  to the bare "no longer open" fact, this recipient's own decision
 *  buttons are unaffected) and "both reviewers have submitted" (FR-11:
 *  every recipient's card updates to the reveal). Never reads one
 *  recipient's data to build another's message — each iteration is an
 *  independent getReviewGate(obligationId, THIS reviewerId) call. */
export async function refreshAllCardsForObligation(obligationId: string, deps: DeliveryDeps): Promise<void> {
  const entries = deps.store.listForObligation(obligationId);
  for (const entry of entries) {
    await deliverOrRefreshCard(obligationId, entry.reviewerId, deps);
  }
}

/** FR-16: after a successful decision, replace this recipient's own card
 *  with a static confirmation. Used for Tier B (single recipient, always
 *  resolved immediately) and for the submitting recipient's own Tier C
 *  message when the tier-C branch's generic refresh
 *  (tierCContextNote's "recorded and locked...") is not specific enough
 *  — callers choose per §6 FR-16's tier-dependent copy. */
export async function sendDecisionConfirmation(
  obligationId: string,
  reviewerId: string,
  decision: "approve" | "reject",
  confirmationCopy: string,
  deps: DeliveryDeps
): Promise<DeliverCardResult> {
  const staticFields = deps.store.getStaticFields(obligationId);
  const existing = deps.store.get(obligationId, reviewerId);
  if (!staticFields || !existing) {
    return { delivered: false, reason: "slack_api_error" };
  }

  const model = await assembleSlackCardModel({
    obligationId,
    reviewerId,
    circularTitle: staticFields.circularTitle,
    category: staticFields.category,
    requirementText: staticFields.requirementText,
    tier: staticFields.tier,
    tierReasons: staticFields.tierReasons,
    confidenceScore: staticFields.confidenceScore,
    groundingScore: staticFields.groundingScore,
    riskScore: staticFields.riskScore,
    slaDueAt: staticFields.slaDueAt,
    slaState: staticFields.slaState,
    escalationReason: staticFields.escalationReason,
    webConsoleBaseUrl: deps.webConsoleBaseUrl
  });

  const { blocks, text } = buildConfirmationCard(model, decision, confirmationCopy);
  const result = await updateMessage({ botToken: deps.botToken, channel: existing.slackChannel, ts: existing.messageTs, blocks, text, fetchImpl: deps.fetchImpl });
  return result.ok ? { delivered: true } : { delivered: false, reason: "slack_api_error" };
}
