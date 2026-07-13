// `Obligation` (graph-schema/src/nodes.ts) has no stored `tier` field —
// review tier is a 1:1 function of `ObligationStatus` for any item
// currently in a reviewable state (`tier_b_review` -> "B", `tier_c_review`
// -> "C", `escalated` -> "ESCALATE"; every other status —
// "proposed"/"tier_a_committed"/"committed"/"rejected" — has no review
// tier at all, since it's not awaiting a human decision). Shared by every
// route handler under app/api/console/** that needs to derive tier from a
// fetched Obligation, so this mapping exists in exactly one place.
import type { ObligationStatus } from "./types";

export type ReviewableTier = "B" | "C" | "ESCALATE";

const STATUS_TO_TIER: Partial<Record<ObligationStatus, ReviewableTier>> = {
  tier_b_review: "B",
  tier_c_review: "C",
  escalated: "ESCALATE"
};

/** `null` when `status` is not a reviewable status at all (Tier A,
 *  proposed, committed, or rejected) — callers treat this as "not
 *  applicable to Operator mode," typically a 404 (§5.1: "obligation not
 *  found or not in a reviewable status"). */
export function tierFromObligationStatus(status: ObligationStatus): ReviewableTier | null {
  return STATUS_TO_TIER[status] ?? null;
}
