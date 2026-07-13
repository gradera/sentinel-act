// Maps the Orchestrator's real WIRE `ReviewGateView` (types.ts — a
// `kind`-discriminated union with the 5-value `TierCGateStatus`, FR-24a) to
// packages/ui's `IndependenceGate` component's `IndependenceState` (a
// DIFFERENT, 3-value vocabulary: "awaiting_assignment" |
// "in_independent_review" | "revealed" — see independence-gate.tsx) and to
// the future `TierCGateBanner` (Spec 09 Task 7, not built in this stage).
//
// ***** SECURITY-CRITICAL FILE *****
// The whole point of Spec 09's Tier C maker-checker flow (UX brief §5
// Journey B, "the hardest UX constraint in this brief") is that a
// checker's browser must never receive the maker's `HumanReview.decision`/
// `.rationale` before both reviews exist. The REAL security boundary is
// server-side — `getReviewsVisibleTo` (monitoring-and-audit.agent.ts) and
// `toWireReviewGateView` (orchestrator.review-gate-view.ts, itself backed
// by `deriveReviewGateView` in orchestrator.logic.ts) already redact
// `TierCReviewGateView.reveal` to `null` for anyone who has not yet
// submitted their own review, so by the time a `ReviewGateView` reaches
// this file it is ALREADY SAFE. Every function below nonetheless re-checks
// the `status`/`reveal` invariant defensively before handing anything to a
// UI component, on the same "defense in depth, not the primary guarantee"
// footing `IndependenceGate` itself documents (see its own doc comment) —
// so that a bug introduced later in this adapter (e.g. someone
// accidentally threading a raw `reveal` through before `status` starts
// with `"resolved_"`) fails loud (throws) instead of silently leaking.
import type { HumanReview } from "@sentinel-act/graph-schema";
import type { IndependenceState, ReviewerRole as IndependenceGateRole } from "@sentinel-act/ui/components/governance/independence-gate";
import type { ReviewGateView, TierCReviewGateView } from "./types";

/** Thrown when a `TierCReviewGateView` violates its own documented
 *  invariant (`reveal` populated while `status` does not start with
 *  `"resolved_"`, or `reveal` absent while it does). This should be
 *  structurally impossible if `toWireReviewGateView` is the only producer
 *  of this shape, but this file treats that as a runtime assertion, not an
 *  assumption — the cost of being wrong here is a data leak. */
export class ReviewGateInvariantError extends Error {
  constructor(message: string) {
    super(`review-gate-adapter: ${message}`);
    this.name = "ReviewGateInvariantError";
  }
}

function isResolvedStatus(status: TierCReviewGateView["status"]): boolean {
  return status === "resolved_agree" || status === "resolved_disagree";
}

/** Defensive re-check of the invariant `toWireReviewGateView`
 *  (orchestrator.review-gate-view.ts) is supposed to already guarantee for
 *  Tier C views: `reveal !== null` if and only if `status` starts with
 *  `"resolved_"`. Every exported function in this file that touches a Tier
 *  C view's `reveal` calls this FIRST. `tier_b`/`escalate` views have no
 *  equivalent status/reveal pair to cross-check (`existingDecision` is
 *  already redacted to "my own decision only, or null" upstream), so this
 *  is a no-op for those kinds. */
function assertTierCReviewGateInvariant(view: TierCReviewGateView): void {
  const revealed = view.reveal !== null;
  const resolved = isResolvedStatus(view.status);
  if (revealed !== resolved) {
    throw new ReviewGateInvariantError(
      `reveal is ${revealed ? "populated" : "null"} but status is "${view.status}" — these must agree (reveal only ` +
        "when status starts with \"resolved_\"). Refusing to derive a UI state from an inconsistent ReviewGateView " +
        "rather than guess which side is wrong."
    );
  }
}

/** Maps the real 5-value `TierCGateStatus` to `IndependenceGate`'s 3-value
 *  `IndependenceState`. Throws for `view.kind !== "tier_c"` —
 *  `IndependenceGate` is a Tier C-only component (see its own doc comment,
 *  "the front-end signal for Tier C maker-checker independence"); Tier B
 *  and ESCALATE items should never be routed through this function
 *  (callers should use `view.existingDecision` directly for those kinds
 *  instead, not built in this foundation stage).
 *
 *  Mapping rationale:
 *   - "resolved_agree" | "resolved_disagree" -> "revealed"          (both
 *     reviews exist, safe to show — the agree/disagree distinction itself
 *     is not part of `IndependenceState`, only whether it's safe to reveal)
 *   - "viewer_submitted_awaiting_peer" -> "awaiting_assignment"      (viewer
 *     already submitted and is locked out until a peer appears — FR-22's
 *     "recorded and locked" screen)
 *   - "unclaimed" | "claimed_by_viewer" -> "in_independent_review"   (viewer
 *     has not submitted yet; whatever the peer has or hasn't done is
 *     hidden from them either way — this is the same "you're mid-review"
 *     posture regardless of whether the viewer has claimed a slot yet) */
export function toIndependenceState(view: ReviewGateView): IndependenceState {
  if (view.kind !== "tier_c") {
    throw new ReviewGateInvariantError(
      `toIndependenceState called with kind="${view.kind}" — IndependenceGate is Tier C-only; callers must not ` +
        "route Tier B/ESCALATE views through this function."
    );
  }
  assertTierCReviewGateInvariant(view);

  switch (view.status) {
    case "resolved_agree":
    case "resolved_disagree":
      return "revealed";
    case "viewer_submitted_awaiting_peer":
      return "awaiting_assignment";
    case "unclaimed":
    case "claimed_by_viewer":
      return "in_independent_review";
  }
}

/** `IndependenceGate`'s `role` prop only accepts `"maker" | "checker"`
 *  (no `null`) — it is a Tier C-only component per its own doc comment.
 *  Tier B/ESCALATE have no maker/checker slot concept at all, so this
 *  function throws rather than fabricate a role for a caller that
 *  mistakenly tries to render `IndependenceGate` for a non-Tier-C item;
 *  callers should gate Tier B/ESCALATE rendering through their own
 *  `existingDecision`-based UI instead (not built in this foundation
 *  stage). */
export function toIndependenceGateRole(viewerSlot: "maker" | "checker" | null): IndependenceGateRole {
  if (viewerSlot === null) {
    throw new ReviewGateInvariantError(
      "toIndependenceGateRole called with viewerSlot=null — IndependenceGate is Tier C-only and requires a " +
        "claimed slot; this is a caller bug (Tier B/ESCALATE have no maker/checker concept), not a data issue."
    );
  }
  return viewerSlot;
}

/** `IndependenceGate`'s `reviews` prop wants exactly `[HumanReview,
 *  HumanReview]` (a tuple), and ONLY when `state === "revealed"` — see
 *  independence-gate.tsx's own FR-16 defensive refusal ("Refusing to
 *  render to avoid leaking a reviewer's decision"). This function is the
 *  single place that tuple gets constructed, so there is exactly one spot
 *  to audit: it returns `null` for every non-`"tier_c"` kind and every
 *  non-resolved status, and ALSO returns `null` (never throws past the
 *  caller) if `reveal.reviews` doesn't have exactly 2 entries even when
 *  resolved — should be structurally impossible per `toWireReviewGateView`,
 *  but this is the same defensive posture as the rest of this file. */
export function toIndependenceGateReviews(view: ReviewGateView): [HumanReview, HumanReview] | null {
  if (view.kind !== "tier_c") {
    return null;
  }
  assertTierCReviewGateInvariant(view);

  if (!isResolvedStatus(view.status) || view.reveal === null) {
    return null;
  }
  if (view.reveal.reviews.length !== 2) {
    return null;
  }
  const [first, second] = view.reveal.reviews;
  return [first, second];
}

/** FR-23's agree/disagree distinction is carried directly on the wire
 *  shape now (`TierCReviewGateView.reveal.agreement`, computed
 *  server-side by `toWireReviewGateView` by comparing the two revealed
 *  decisions) — this helper just exposes it as the same 3-value
 *  `"agree" | "disagree" | null` shape the rest of this app expects,
 *  returning `null` when the gate is not yet resolved (nothing to
 *  compare) or is not a Tier C view at all. Mirrors
 *  `toIndependenceGateReviews`'s same guard so the two functions never
 *  disagree about what counts as "resolved" for Tier C purposes. */
export function toTierCAgreement(view: ReviewGateView): "agree" | "disagree" | null {
  if (view.kind !== "tier_c") {
    return null;
  }
  assertTierCReviewGateInvariant(view);

  if (!isResolvedStatus(view.status) || view.reveal === null) {
    return null;
  }
  return view.reveal.agreement ? "agree" : "disagree";
}
