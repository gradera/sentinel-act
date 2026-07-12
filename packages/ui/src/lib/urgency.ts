// Framework Tier 1/2/3 info-hierarchy (Progressive Disclosure), distinct
// from the A/B/C risk-tier governance gate rendered by RiskTierBadge —
// see globals.css's comment on the two separate token groups, and
// Spec 14 FR-7 (UrgencyBadge and RiskTierBadge must never share tokens).
export type UrgencyLevel = "now" | "in-motion" | "archive";

export interface ComputeUrgencyInput {
  /** ISO datetime the item is due by. null if no SLA applies (e.g. an
   *  already-committed Tier A item, or an item with no routing yet). */
  slaDueAt: string | null;
  /** HumanReview.decided_at if a decision already exists, else null.
   *  A decided item is always "archive" regardless of its former SLA. */
  decidedAt: string | null;
  /** Hours-before-due at which an undecided item becomes "now".
   *  Default 4. This threshold is an engineering placeholder pending
   *  compliance/ops sign-off on real SLA urgency bands (Spec 14 §13) —
   *  not a regulator-approved value. Exposed so Spec 09 can override it
   *  per obligation category once real bands are defined. */
  nowThresholdHours?: number;
  /** Injectable for tests; defaults to `new Date()`. */
  now?: Date;
}

const DEFAULT_NOW_THRESHOLD_HOURS = 4;

/**
 * Spec 14 FR-4/FR-5: decided items are always "archive"; undecided items
 * are "now" once at-or-past `nowThresholdHours` before due (including
 * already-breached — a miss must read as loud "now", not merely
 * re-sorted), otherwise "in-motion". An item with no SLA at all
 * (`slaDueAt: null`) and no decision defaults to "in-motion" — never a
 * false-alarm "now", never a false-done "archive" (Spec 14 §8 edge case
 * table).
 */
export function computeUrgency(input: ComputeUrgencyInput): UrgencyLevel {
  const { slaDueAt, decidedAt, nowThresholdHours = DEFAULT_NOW_THRESHOLD_HOURS, now = new Date() } = input;

  if (decidedAt !== null) {
    return "archive";
  }

  if (slaDueAt === null) {
    return "in-motion";
  }

  const dueAt = new Date(slaDueAt).getTime();
  const nowMs = now.getTime();
  const thresholdMs = nowThresholdHours * 60 * 60 * 1000;

  // At-or-before now + threshold covers both "approaching" and
  // "already breached" (dueAt < nowMs) in one comparison.
  if (dueAt <= nowMs + thresholdMs) {
    return "now";
  }

  return "in-motion";
}
