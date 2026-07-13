// Spec 08 gap-closure: `GET /api/orchestrator/review-sla/due-soon-and-breached`
// (Spec 11 §5.3's "new proposed contract this spec adds for Spec 08").
// Investigation confirmed the endpoint genuinely did not exist —
// `SuspendedRunIndexPort` only tracked `{runId, stepId}` and claim slots,
// no suspend timestamp or tier. orchestrator.types.ts's
// `SuspendedRunIndexEntry`/`SuspendedRunIndexPort` were extended
// (tier/suspendedAt/listActive/hasSentDueSoonReminder/
// markDueSoonReminderSent) so this module can be built as a real,
// grounded read over live suspended-run state — not a mock.
//
// SLA policy constants are DUPLICATED from
// apps/web-console/lib/console/sla.ts (SLA_DUE_SOON_WINDOW_HOURS = 4,
// REVIEW_SLA_HOURS_TIER_B = 24, REVIEW_SLA_HOURS_TIER_C = 12), not
// imported — following the exact precedent orchestrator.review-gate-view.ts's
// own header comment already establishes for this codebase: apps/orchestrator
// and apps/web-console are two independently deployed processes, kept in
// lockstep by contract, not by cross-app import.
//
// GENUINE, INTENTIONAL PRODUCT GAPS (not oversights — do not "fix" these
// without a real product decision backing it):
//
//   1. Tier B due-soon detection: there is no `assignedReviewerId` concept
//      for Tier B anywhere in apps/ — Spec 09's own
//      apps/web-console/app/api/console/queue/route.ts documents this at
//      its own top as "Gap 1." Tier B entries are read from
//      `listActive()` but never produce a `dueSoon` row: there is no
//      reviewerId to notify.
//
//   2. ALL breach detection / backup-reviewer reassignment: there is no
//      backup-reviewer registry or policy anywhere in the shipped system
//      (confirmed by a repo-wide grep for "backup" — zero hits outside
//      Spec 11's own proposed, not-yet-real contract). `breached` is
//      therefore always `[]`. Fabricating a `backupReviewerId` here would
//      be inventing product policy this implementation has no authority
//      to invent.
//
// Both gaps were an explicit, deliberate product decision (the user chose
// "build the real, groundable parts only; leave Tier B due-soon detection
// and ALL breach/backup-reviewer reassignment as an honestly-documented
// gap"), matching this codebase's own established pattern of flagging
// gaps in code comments rather than inventing policy.
import type { SuspendedRunIndexEntry, SuspendedRunIndexPort } from "./orchestrator.types.js";
import { getOrchestratorRuntime } from "./orchestrator.workflow.js";

// ---------------------------------------------------------------------------
// Duplicated SLA policy constants — see header comment for why these are
// not imported from apps/web-console/lib/console/sla.ts.
// ---------------------------------------------------------------------------

/** Mirrors apps/web-console/lib/console/sla.ts's own FR-4 constant: the
 *  4-hour "getting close" window. Unconfirmed placeholder pending
 *  compliance/ops sign-off, same status as the source constant. */
export const SLA_DUE_SOON_WINDOW_HOURS = 4;

/** Mirrors apps/web-console/lib/console/sla.ts's FR-3 constants:
 *  `suspendedAt + reviewSlaHours(tier)` is the review SLA due date. */
export const REVIEW_SLA_HOURS_TIER_B = 24;
export const REVIEW_SLA_HOURS_TIER_C = 12;

/** Spec 09 FR-3, reimplemented here: `slaDueAt = suspendedAt +
 *  reviewSlaHours(tier)`. */
export function computeSlaDueAt(suspendedAt: string, tier: "B" | "C"): string {
  const hours = tier === "B" ? REVIEW_SLA_HOURS_TIER_B : REVIEW_SLA_HOURS_TIER_C;
  return new Date(new Date(suspendedAt).getTime() + hours * 60 * 60 * 1000).toISOString();
}

export type FeedSlaState = "ok" | "due_soon" | "breached";

/** Mirrors apps/web-console/lib/console/sla.ts's `computeSlaState`
 *  semantics exactly (breached when `now >= slaDueAt`; due_soon when
 *  within `SLA_DUE_SOON_WINDOW_HOURS`; else ok) — reimplemented, not
 *  imported, for the same cross-app-independence reason as the constants
 *  above. Unlike the web-console version, `slaDueAt` here is never null
 *  (every `listActive()` entry has a real `suspendedAt`), so there is no
 *  "no SLA yet" case to special-case. */
export function computeFeedSlaState(slaDueAt: string, now: Date): FeedSlaState {
  const dueAtMs = new Date(slaDueAt).getTime();
  const nowMs = now.getTime();
  const dueSoonWindowMs = SLA_DUE_SOON_WINDOW_HOURS * 60 * 60 * 1000;
  if (nowMs >= dueAtMs) {
    return "breached";
  }
  if (dueAtMs - nowMs <= dueSoonWindowMs) {
    return "due_soon";
  }
  return "ok";
}

// ---------------------------------------------------------------------------
// Wire response shape — matches Spec 11's `SlaBreachFeedResult`
// (apps/orchestrator/src/slack/sla-reminder-scheduler.ts's
// `SlaDueSoonEntry`/`SlaBreachedEntry`) field-for-field, so
// `createHttpSlaBreachFeedPort` can deserialize this response unchanged.
// ---------------------------------------------------------------------------

export interface SlaDueSoonFeedEntry {
  obligationId: string;
  reviewerId: string;
  slaDueAt: string;
}

export interface SlaBreachedFeedEntry {
  obligationId: string;
  previousReviewerId: string;
  backupReviewerId: string;
  slaDueAt: string;
}

export interface SlaBreachFeedResponse {
  dueSoon: SlaDueSoonFeedEntry[];
  breached: SlaBreachedFeedEntry[];
}

/** GET /api/orchestrator/review-sla/due-soon-and-breached's core logic —
 *  pure, dependency-injected, unit-testable without Mastra, exactly like
 *  `handleReviewGateRequest`/`handleClaimRequest` in orchestrator.workflow.ts
 *  (same style: typed deps param with a real default reading
 *  `getOrchestratorRuntime()`). Auth is NOT checked here — mirrors
 *  `handleRunRef`'s split (the HTTP layer in http-server.ts calls
 *  `assertServiceAuth` itself before invoking this function), since this
 *  is a literal-path, no-request-body GET route with nothing to validate
 *  beyond the auth header. */
export async function handleSlaBreachFeedRequest(
  deps: { index: SuspendedRunIndexPort } = { index: getOrchestratorRuntime().index },
  now: () => Date = () => new Date()
): Promise<SlaBreachFeedResponse> {
  const active = await deps.index.listActive();
  const nowDate = now();
  const dueSoon: SlaDueSoonFeedEntry[] = [];

  for (const entry of active) {
    if (entry.tier === "B") {
      // Gap 1 (see header comment): no assignedReviewerId concept exists
      // for Tier B anywhere in the shipped system. There is no reviewerId
      // to notify, so Tier B entries never produce a dueSoon row,
      // regardless of how overdue they are.
      continue;
    }

    const slaDueAt = computeSlaDueAt(entry.suspendedAt, entry.tier);
    const state = computeFeedSlaState(slaDueAt, nowDate);
    if (state !== "due_soon") {
      // "ok" isn't due yet; "breached" Tier C entries are a real, grounded
      // case this function COULD detect, but there is still nowhere to
      // route them (no backup-reviewer policy — Gap 2, header comment) so
      // this function intentionally only acts on "due_soon" here. The
      // `breached` array below is always `[]`.
      continue;
    }

    const slots = await deps.index.getClaimSlots(entry.obligation_id);
    const claimedReviewerIds = [slots?.maker ?? null, slots?.checker ?? null];
    for (const reviewerId of claimedReviewerIds) {
      if (!reviewerId) {
        // Unclaimed slot — no reviewerId to notify (same reasoning as the
        // Tier B skip above).
        continue;
      }
      if (await deps.index.hasSentDueSoonReminder(entry.obligation_id, reviewerId)) {
        // Already returned once for this (obligation_id, reviewerId) —
        // Spec 11 §5.3: "this endpoint only ever returns each item once
        // per state transition."
        continue;
      }
      dueSoon.push({ obligationId: entry.obligation_id, reviewerId, slaDueAt });
      await deps.index.markDueSoonReminderSent(entry.obligation_id, reviewerId);
    }
  }

  return {
    dueSoon,
    // Always []: see Gap 2 in this file's header comment. No
    // backup-reviewer registry/policy exists anywhere in the shipped
    // system (confirmed by a repo-wide grep for "backup" — zero hits
    // outside Spec 11's own proposed-contract doc comments). Returning a
    // fabricated backupReviewerId would be inventing product policy this
    // implementation has no authority to invent. This is a genuine,
    // intentionally-left-open product gap, not dead code.
    breached: []
  };
}

// Re-exported for callers that only need the entry shape (e.g. tests
// constructing fixtures directly against InMemorySuspendedRunIndex).
export type { SuspendedRunIndexEntry };
