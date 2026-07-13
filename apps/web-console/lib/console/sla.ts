// Spec 09 FR-3/FR-4 — reviewer SLA state derivation.
//
// `SlaState` ("ok"|"due_soon"|"breached") is a DELIBERATELY separate
// vocabulary from packages/ui's `UrgencyLevel` ("now"|"in-motion"|
// "archive", packages/ui/src/lib/urgency.ts) per
// docs/specs/00-context-and-conventions.md's "risk tier vs urgency tier"
// convention (RiskTierBadge's A/B/C/ESCALATE governance tokens must never
// be conflated with UrgencyBadge's Tier-1/2/3 progressive-disclosure
// tokens — Spec 14 FR-7 makes the same separation for the sibling
// risk/urgency distinction). This file's threshold logic intentionally
// MIRRORS `computeUrgency`'s semantics (a 4-hour "getting close" window,
// and the same "no SLA is a neutral state, not an alarm" edge case) —
// but returns Spec 09's own 3-value type, not `UrgencyLevel`, because the
// two badges render different things (queue/detail's raw SLA countdown
// vs. the cross-cutting Tier-1/2/3 disclosure badge) and a later UI stage
// still has to write its own `SlaState -> UrgencyLevel` mapping wherever
// `UrgencyBadge` is reused (Spec 09 Task 6, `SlaBanner`) — not done here.
import type { SlaState } from "./types";

/** FR-4: the 4-hour "getting close" window, named and exported per Spec
 *  09 §13's explicit instruction ("named exported constant
 *  `SLA_DUE_SOON_WINDOW_HOURS`, not a magic number") — an unconfirmed
 *  placeholder pending compliance/ops sign-off, same status as every
 *  other threshold constant in this codebase (risk-score.scorer.ts's
 *  `RISK_TIER_C_THRESHOLD` etc., monitoring-and-audit.agent.ts's
 *  `SLA_APPROACHING_THRESHOLD_RATIO`). */
export const SLA_DUE_SOON_WINDOW_HOURS = 4;

/** FR-3: `reviewSlaHours` — how long a REVIEWER has to act once a
 *  workflow step suspends for human review, computed by the Orchestrator
 *  as `suspendedAt + reviewSlaHours(tier)`. Distinct from
 *  `ProcessTask.sla_hours` (the operational task's own SLA once
 *  committed) — this unit only displays the result, per FR-3's own text,
 *  it does not compute `slaDueAt`. Unconfirmed placeholders (Spec 09
 *  §13), shipped as named exported constants so they are a one-line
 *  change once a real compliance-approved SLA policy exists. */
export const REVIEW_SLA_HOURS_TIER_B = 24;
export const REVIEW_SLA_HOURS_TIER_C = 12;

/** Convenience lookup over the two constants above, keyed by the same
 *  `ReviewTier` values `reviewSlaHours(tier)` is described as taking in
 *  FR-3's prose. Tier A never suspends for human review (no Tier A
 *  reviewer UI, FR-1) so it is intentionally not a key here — indexing
 *  with "A" is a caller bug, not a runtime case to handle gracefully. */
export const reviewSlaHours: Record<"B" | "C", number> = {
  B: REVIEW_SLA_HOURS_TIER_B,
  C: REVIEW_SLA_HOURS_TIER_C
};

/** FR-4: `"breached"` when `now >= slaDueAt`, `"due_soon"` when
 *  `slaDueAt - now <= SLA_DUE_SOON_WINDOW_HOURS` hours, else `"ok"`.
 *
 *  `slaDueAt: null` (no review SLA clock running yet — e.g. a
 *  degraded-read placeholder per Spec 09 §8's Orchestrator-unavailable
 *  row, or an item that has not yet suspended for human review) maps to
 *  `"ok"`: the neutral, non-alarming state, mirroring `computeUrgency`'s
 *  same "no SLA at all is never a false alarm" edge case (packages/ui/
 *  src/lib/urgency.ts). Callers rendering the Spec 09 §8 "status
 *  unavailable" degraded placeholder must do so explicitly themselves
 *  (this function has no way to distinguish "no SLA yet" from "SLA data
 *  unavailable" — both arrive here as `null`) — this function only
 *  answers "given a due date, what bucket is it in," not "do we trust
 *  this due date." */
// ---------------------------------------------------------------------------
// FR-5: queue sort comparator — riskScore DESC, then slaDueAt ASC NULLS
// LAST, stable. `fetchQueueItems` (graph-queries.ts) already applies
// `ORDER BY t.risk_score DESC` in Cypher; this comparator is the "stable
// secondary in-memory sort by slaDueAt after the Orchestrator SLA data is
// merged in" FR-5 explicitly calls out as a separate step (the graph query
// has no access to Orchestrator-owned slaDueAt at all). `Array.prototype.sort`
// in modern V8/Node is a stable sort (ECMA-262 spec-guaranteed since
// ES2019), so ties on both riskScore and slaDueAt preserve the Cypher
// query's original relative order rather than needing a third tiebreaker
// here.
// ---------------------------------------------------------------------------

export interface QueueSortable {
  riskScore: number;
  slaDueAt: string | null;
}

export function compareQueueItems(a: QueueSortable, b: QueueSortable): number {
  if (a.riskScore !== b.riskScore) {
    return b.riskScore - a.riskScore; // DESC
  }
  if (a.slaDueAt === null && b.slaDueAt === null) {
    return 0;
  }
  if (a.slaDueAt === null) {
    return 1; // NULLS LAST
  }
  if (b.slaDueAt === null) {
    return -1;
  }
  return new Date(a.slaDueAt).getTime() - new Date(b.slaDueAt).getTime(); // ASC
}

export function computeSlaState(slaDueAt: string | null, now: Date = new Date()): SlaState {
  if (slaDueAt === null) {
    return "ok";
  }

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
