import { IndependenceGate } from "@sentinel-act/ui/components/governance/independence-gate";
import { toIndependenceGateReviews, toIndependenceGateRole, toIndependenceState } from "@/lib/console/review-gate-adapter";
import type { TierCReviewGateView } from "@/lib/console/types";

/**
 * TierCGateBanner — Spec 09 screens 04/05/06 wrapper around
 * `IndependenceGate`. All three states' copy ("Awaiting a second,
 * independent reviewer." / "You are reviewing independently — the other
 * reviewer's decision is hidden until you submit yours." / the revealed
 * both-reviews layout) is already hardcoded inside `IndependenceGate`
 * itself (see independence-gate.tsx's `STATE_COPY` map and its
 * `state === "revealed"` branch) — this component's only job is mapping
 * the real 5-value `TierCGateStatus` down to `IndependenceGate`'s 3-value
 * `IndependenceState` via review-gate-adapter.ts's existing, already
 * security-reviewed helpers, never re-deriving that mapping here.
 */
export function TierCGateBanner({
  reviewGate,
  children
}: {
  reviewGate: TierCReviewGateView;
  children: React.ReactNode;
}) {
  const state = toIndependenceState(reviewGate);
  const reviews = toIndependenceGateReviews(reviewGate);
  const role = reviewGate.viewerSlot !== null ? toIndependenceGateRole(reviewGate.viewerSlot) : null;

  // Before a slot is claimed there is no maker/checker role to render
  // `IndependenceGate` with yet (it is Tier C-only and requires a claimed
  // slot, per its own doc comment) — the claim UI, not this banner, owns
  // that pre-claim moment.
  if (role === null) {
    return <>{children}</>;
  }

  return (
    <IndependenceGate role={role} state={state} reviews={reviews}>
      {children}
    </IndependenceGate>
  );
}
