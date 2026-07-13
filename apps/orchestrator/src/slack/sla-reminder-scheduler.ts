// Spec 11 §11 Task 9, §6 FR-17–FR-21, §5.3's new proposed SLA-breach feed
// contract.
//
// UPDATE (Spec 08 gap closed): §5.3 proposed
// `GET {ORCHESTRATOR_BASE_URL}/api/orchestrator/review-sla/due-soon-and-breached`
// as "a new proposed contract this spec adds for Spec 08" (§13's own
// words). That endpoint now EXISTS and is REAL —
// apps/orchestrator/src/server/http-server.ts wires it to
// `handleSlaBreachFeedRequest` (orchestrator.sla-feed.ts), which reads
// live suspended-run state via the extended `SuspendedRunIndexPort`
// (orchestrator.types.ts: `tier`/`suspendedAt` on
// `SuspendedRunIndexEntry`, plus `listActive`/`hasSentDueSoonReminder`/
// `markDueSoonReminderSent`). `createHttpSlaBreachFeedPort` below talks to
// a real, working server.
//
// This closure is PARTIAL, by deliberate product decision, not oversight:
//
//   - `dueSoon` is real and grounded for Tier C ONLY. Tier B due-soon
//     detection remains unimplementable: there is no `assignedReviewerId`
//     concept for Tier B anywhere in the shipped system (Spec 09's own
//     apps/web-console/app/api/console/queue/route.ts documents this
//     identical gap at its own top, "Gap 1") — there is no reviewerId to
//     notify.
//
//   - `breached` is ALWAYS `[]`. There is no backup-reviewer
//     registry/policy anywhere in the shipped system (confirmed by a
//     repo-wide grep for "backup" — zero hits outside this spec's own
//     proposed-contract doc comments). `handleBreachedEntry` below is
//     therefore fully implemented and tested (mock-fed) but, against the
//     real endpoint, is currently dead code by construction — it will
//     activate the moment a real backup-reviewer policy exists and
//     `breached` starts returning entries.
//
// See orchestrator.sla-feed.ts's own header comment for the full
// reasoning behind both gaps. `runSlaSchedulerCycle`'s own logic
// (dedup-by-trusting-the-feed, batching, breach escalation, non-fatal DM
// failure handling) remains fully implemented and covered by tests using
// a mock `SlaBreachFeedPort` — those tests are unaffected by the real
// endpoint now existing, since they never depended on it.
import { createHmac } from "node:crypto";
import { buildBreachedReassignmentCard, buildReviewCardWithReminder } from "./blocks.js";
import { assembleSlackCardModel } from "./card-model.js";
import { postMessage, updateMessage } from "./slack-client.js";
import { resolveDmChannel, type DmChannelCache, type SlackUserMappingStore } from "./user-mapping.js";
import type { DeliveryDeps, CardStaticFields, SentCardStore } from "./delivery.js";
import { SLA_DUE_SOON_WINDOW_HOURS, SLA_POLL_INTERVAL_MINUTES } from "./config.js";

export { SLA_DUE_SOON_WINDOW_HOURS, SLA_POLL_INTERVAL_MINUTES };

export interface SlaDueSoonEntry {
  obligationId: string;
  reviewerId: string;
  slaDueAt: string;
}

export interface SlaBreachedEntry {
  obligationId: string;
  previousReviewerId: string;
  backupReviewerId: string;
  slaDueAt: string;
}

export interface SlaBreachFeedResult {
  dueSoon: SlaDueSoonEntry[];
  breached: SlaBreachedEntry[];
}

export interface SlaBreachFeedPort {
  getDueSoonAndBreached(): Promise<SlaBreachFeedResult>;
}

/** Real HTTP adapter for §5.3's proposed feed — see this file's header
 *  comment for the endpoint's current (non-)existence status. Mints its
 *  own service JWT the same way orchestrator-client.ts does for its
 *  in-process calls, since this one genuinely is an HTTP call (the feed
 *  is explicitly specified as an HTTP contract, §5.3, not a proposed
 *  in-process function like getReviewGate/claimReviewSlot/resumeReviewStep). */
export function createHttpSlaBreachFeedPort(orchestratorBaseUrl: string, serviceJwtSecret: string, fetchImpl: typeof fetch = fetch): SlaBreachFeedPort {
  return {
    async getDueSoonAndBreached(): Promise<SlaBreachFeedResult> {
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({ sub: "slack-gateway", exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
      const signature = createHmac("sha256", serviceJwtSecret).update(`${header}.${payload}`).digest("base64url");
      const token = `${header}.${payload}.${signature}`;

      const response = await fetchImpl(`${orchestratorBaseUrl}/api/orchestrator/review-sla/due-soon-and-breached`, {
        headers: { authorization: `Bearer ${token}` }
      });
      if (!response.ok) {
        throw new Error(`SLA breach feed returned HTTP ${response.status}`);
      }
      return (await response.json()) as SlaBreachFeedResult;
    }
  };
}

export interface SlaSchedulerDeps extends DeliveryDeps {
  feed: SlaBreachFeedPort;
  userMappingStore: SlackUserMappingStore;
  /** #sentinel-act-escalations channel id (FR-19c) — a public/shared
   *  channel the bot is a member of, distinct from any reviewer DM. */
  escalationsChannelId: string;
  onCycleError?: (error: unknown) => void;
}

export interface SlaSchedulerCycleResult {
  dueSoonHandled: number;
  breachedHandled: number;
  skipped: boolean;
}

/** FR-17/FR-18: exactly-once-per-transition reminder, trusting the feed's
 *  own due-soon flag (§5.3) rather than re-deriving dedup here. */
async function sendDueSoonReminder(entry: SlaDueSoonEntry, deps: SlaSchedulerDeps): Promise<void> {
  const staticFields = deps.store.getStaticFields(entry.obligationId);
  const existing = deps.store.get(entry.obligationId, entry.reviewerId);
  if (!staticFields || !existing) {
    // Nothing to update — this unit never sent a card for this
    // obligation/reviewer (e.g. no SlackUserMapping at delivery time).
    // §8: Slack is supplementary; the console queue is unaffected.
    return;
  }
  const model = await assembleSlackCardModel({
    obligationId: entry.obligationId,
    reviewerId: entry.reviewerId,
    circularTitle: staticFields.circularTitle,
    category: staticFields.category,
    requirementText: staticFields.requirementText,
    tier: staticFields.tier,
    tierReasons: staticFields.tierReasons,
    confidenceScore: staticFields.confidenceScore,
    groundingScore: staticFields.groundingScore,
    riskScore: staticFields.riskScore,
    slaDueAt: entry.slaDueAt,
    slaState: "due_soon",
    escalationReason: staticFields.escalationReason,
    webConsoleBaseUrl: deps.webConsoleBaseUrl
  });
  const { blocks, text } = buildReviewCardWithReminder(model);
  await updateMessage({ botToken: deps.botToken, channel: existing.slackChannel, ts: existing.messageTs, blocks, text, fetchImpl: deps.fetchImpl });
}

/** FR-19–FR-21. */
async function handleBreachedEntry(entry: SlaBreachedEntry, deps: SlaSchedulerDeps): Promise<void> {
  const staticFields = deps.store.getStaticFields(entry.obligationId);

  // (a) previous reviewer's card -> "reassigned, SLA missed", no actions.
  const previousEntry = deps.store.get(entry.obligationId, entry.previousReviewerId);
  if (staticFields && previousEntry) {
    const previousModel = await assembleSlackCardModel({
      obligationId: entry.obligationId,
      reviewerId: entry.previousReviewerId,
      circularTitle: staticFields.circularTitle,
      category: staticFields.category,
      requirementText: staticFields.requirementText,
      tier: staticFields.tier,
      tierReasons: staticFields.tierReasons,
      confidenceScore: staticFields.confidenceScore,
      groundingScore: staticFields.groundingScore,
      riskScore: staticFields.riskScore,
      slaDueAt: entry.slaDueAt,
      slaState: "breached",
      escalationReason: staticFields.escalationReason,
      webConsoleBaseUrl: deps.webConsoleBaseUrl
    });
    const { blocks, text } = buildBreachedReassignmentCard(previousModel);
    await updateMessage({ botToken: deps.botToken, channel: previousEntry.slackChannel, ts: previousEntry.messageTs, blocks, text, fetchImpl: deps.fetchImpl }).catch(
      (err) => deps.onCycleError?.(err)
    );
  }

  // (b) new DM to the backup reviewer with a catch-up card — best-effort,
  // non-fatal (FR-21): logged, never blocks (c) below.
  let dmDelivered = false;
  try {
    const mapping = deps.userMappingStore.findByReviewerId(entry.backupReviewerId);
    if (mapping && staticFields) {
      const channelId = await resolveDmChannel(mapping.slackUserId, { botToken: deps.botToken, cache: deps.dmCache, fetchImpl: deps.fetchImpl });
      if (channelId) {
        const backupModel = await assembleSlackCardModel({
          obligationId: entry.obligationId,
          reviewerId: entry.backupReviewerId,
          circularTitle: staticFields.circularTitle,
          category: staticFields.category,
          requirementText: staticFields.requirementText,
          tier: staticFields.tier,
          tierReasons: staticFields.tierReasons,
          confidenceScore: staticFields.confidenceScore,
          groundingScore: staticFields.groundingScore,
          riskScore: staticFields.riskScore,
          slaDueAt: entry.slaDueAt,
          slaState: "breached",
          // FR-20: "why you're seeing this" line. `previousReviewerName`
          // is not part of §5.3's feed contract (only previousReviewerId
          // is) — the reviewerId is used as the display name, a
          // documented limitation until Spec 08's feed carries a display
          // name too.
          escalationReason: `SLA missed — reassigned from ${entry.previousReviewerId}, waiting ${elapsedSinceDue(entry.slaDueAt)}`,
          webConsoleBaseUrl: deps.webConsoleBaseUrl
        });
        const { blocks, text } = buildReviewCardWithReminder(backupModel);
        const result = await postMessage({ botToken: deps.botToken, channel: channelId, blocks, text, fetchImpl: deps.fetchImpl });
        if (result.ok && result.ts) {
          deps.store.record({ obligationId: entry.obligationId, reviewerId: entry.backupReviewerId, slackChannel: channelId, messageTs: result.ts });
          dmDelivered = true;
        }
      }
    }
  } catch (err) {
    deps.onCycleError?.(err);
  }
  if (!dmDelivered) {
    deps.onCycleError?.(new Error(`SLA breach DM delivery failed for backup reviewer ${entry.backupReviewerId} on obligation ${entry.obligationId}`));
  }

  // (c) #sentinel-act-escalations channel post — MUST fire even if (b)
  // failed (FR-21).
  const title = staticFields?.circularTitle ?? entry.obligationId;
  await postMessage({
    botToken: deps.botToken,
    channel: deps.escalationsChannelId,
    text: `🚨 SLA missed on *${title}* (${entry.obligationId}) — reassigned from ${entry.previousReviewerId} to ${entry.backupReviewerId}.`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🚨 *SLA missed* — *${title}* (\`${entry.obligationId}\`)\nReassigned from *${entry.previousReviewerId}* to *${entry.backupReviewerId}*.`
        }
      }
    ],
    fetchImpl: deps.fetchImpl
  }).catch((err) => deps.onCycleError?.(err));
}

function elapsedSinceDue(slaDueAt: string, nowMs: number = Date.now()): string {
  const diffMs = Math.max(0, nowMs - new Date(slaDueAt).getTime());
  const totalMinutes = Math.round(diffMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** FR-18/FR-21: skips the whole cycle (logs, retries next interval) if
 *  the feed itself is unavailable — MUST NOT crash the scheduler process
 *  or block unrelated Slack interaction handling (§8). Each dueSoon/
 *  breached item is otherwise handled independently — one item's Slack
 *  delivery failure does not stop the rest of the cycle. */
export async function runSlaSchedulerCycle(deps: SlaSchedulerDeps): Promise<SlaSchedulerCycleResult> {
  let feedResult: SlaBreachFeedResult;
  try {
    feedResult = await deps.feed.getDueSoonAndBreached();
  } catch (err) {
    deps.onCycleError?.(err);
    return { dueSoonHandled: 0, breachedHandled: 0, skipped: true };
  }

  for (const entry of feedResult.dueSoon) {
    await sendDueSoonReminder(entry, deps).catch((err) => deps.onCycleError?.(err));
  }
  for (const entry of feedResult.breached) {
    await handleBreachedEntry(entry, deps).catch((err) => deps.onCycleError?.(err));
  }

  return { dueSoonHandled: feedResult.dueSoon.length, breachedHandled: feedResult.breached.length, skipped: false };
}

export interface SlaSchedulerHandle {
  stop: () => void;
}

/** NFR-Perf-2/§13: fixed-interval poll loop, placeholder
 *  SLA_POLL_INTERVAL_MINUTES (default 5). Returns a handle so the caller
 *  (app.ts / the process's own startup wiring) can stop it on shutdown —
 *  never left as an unreferenced, unstoppable timer. */
export function startSlaReminderScheduler(deps: SlaSchedulerDeps, pollIntervalMinutes: number = SLA_POLL_INTERVAL_MINUTES): SlaSchedulerHandle {
  const timer = setInterval(() => {
    runSlaSchedulerCycle(deps).catch((err) => deps.onCycleError?.(err));
  }, pollIntervalMinutes * 60_000);
  // Never keep the Node process alive purely for this timer (matches
  // http-server.ts's own posture of not overriding Node's default exit
  // behavior for background timers).
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

// Re-exported so tests / delivery.ts callers do not need parallel imports
// for these two purely-structural types.
export type { CardStaticFields, DeliveryDeps, SentCardStore, DmChannelCache };
