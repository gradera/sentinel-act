"use client";

import * as React from "react";
import { ShieldAlert, CheckCircle2 } from "lucide-react";
import { cn } from "@sentinel-act/ui/lib/utils";
import type { HumanReview } from "@sentinel-act/graph-schema";

/**
 * IndependenceGate — the front-end signal for Tier C maker-checker
 * independence (UX brief §5 Journey B: "the hardest UX constraint in
 * this brief and the most important one"). This component is a
 * DEFENSIVE UI GUARD, not the security boundary: the real guarantee is
 * that the server (Spec 08/09 API layer, the `GET .../review-gate`
 * endpoint backed by Spec 07's `getReviewsVisibleTo`) must never
 * transmit the maker's HumanReview row to the checker's client at all
 * before both exist. FR-16's refusal-to-render below only protects
 * against a caller passing `reviews` early by mistake — it cannot
 * protect against a server that already leaked the data over the wire.
 *
 * Flagging a spec-internal inconsistency rather than silently picking a
 * side (Spec 14 §4's `IndependenceState` doc comments and FR-13's own
 * screen mapping say role="maker" pairs with state="awaiting_assignment"
 * — screen 04, the maker's post-submit view, before a second reviewer
 * exists — while FR-13's prose describes that exact screen as
 * state="in_independent_review". This component does not special-case
 * `role` against a specific `state` value for what it renders (besides
 * the copy lookup) — whichever non-"revealed" state a caller passes for
 * role="maker", this component renders only the state's own static
 * banner copy plus `children`, and never adds any additional
 * second-reviewer progress/assignment UI — satisfying FR-14's actual
 * requirement ("no UI implying visibility into the second reviewer")
 * regardless of which of the two non-revealed state values is in play.
 */

export type ReviewerRole = "maker" | "checker";

export type IndependenceState =
  | "awaiting_assignment" // maker submitted; no second reviewer yet
  | "in_independent_review" // checker (or maker, pre-submission) is
  // actively reviewing; the other side's decision must not be visible
  | "revealed"; // both HumanReview facts exist; safe to show

export interface IndependenceGateProps {
  role: ReviewerRole;
  state: IndependenceState;
  /** Both decisions. MUST be omitted or null by the caller unless
   *  state === "revealed" — see FR-16. */
  reviews?: [HumanReview, HumanReview] | null;
  children: React.ReactNode;
  className?: string;
}

const STATE_COPY: Record<Exclude<IndependenceState, "revealed">, string> = {
  awaiting_assignment: "Awaiting a second, independent reviewer.",
  in_independent_review:
    "You are reviewing independently — the other reviewer's decision is hidden until you submit yours."
};

export function IndependenceGate({ role, state, reviews, children, className }: IndependenceGateProps) {
  const hasReviews = reviews !== undefined && reviews !== null;

  // FR-16: defensive refusal against a caller bug — never render
  // anything (including `children`) if `reviews` is populated outside
  // state === "revealed".
  if (hasReviews && state !== "revealed") {
    if (process.env.NODE_ENV !== "production") {
      console.error(
        `IndependenceGate: \`reviews\` was provided while state is "${state}" (not "revealed"). ` +
          "Refusing to render to avoid leaking a reviewer's decision before independence is established. " +
          "This is a defensive front-end guard only — the real independence guarantee must be enforced " +
          "server-side (the maker's HumanReview must never reach the checker's client before both exist)."
      );
    }
    return null;
  }

  if (state === "revealed") {
    return (
      <div className={cn("space-y-4", className)} data-slot="independence-gate" data-state={state} data-role={role}>
        <div className="flex items-center gap-2 rounded-md border border-[hsl(var(--risk-a))]/30 bg-[hsl(var(--risk-a))]/10 px-3 py-2 text-sm">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-[hsl(var(--risk-a))]" aria-hidden="true" />
          <span>Both independent reviews are in.</span>
        </div>
        {reviews && (
          <div className="grid gap-3 sm:grid-cols-2" data-slot="independence-gate-reviews">
            {reviews.map((review) => (
              <div key={review.review_id} className="rounded-md border p-3 text-sm">
                <div className="mb-1 font-medium">{review.reviewer_id}</div>
                <div className="text-muted-foreground">
                  {review.decision === "approve" ? "Approved" : "Rejected"} ·{" "}
                  {new Date(review.decided_at).toLocaleString()}
                </div>
                {review.rationale && <p className="mt-2 text-foreground">{review.rationale}</p>}
              </div>
            ))}
          </div>
        )}
        {children}
      </div>
    );
  }

  return (
    <div className={cn("space-y-4", className)} data-slot="independence-gate" data-state={state} data-role={role}>
      <div className="flex items-center gap-2 rounded-md border border-[hsl(var(--urgency-in-motion))]/30 bg-[hsl(var(--urgency-in-motion))]/10 px-3 py-2 text-sm">
        <ShieldAlert className="h-4 w-4 shrink-0 text-[hsl(var(--urgency-in-motion))]" aria-hidden="true" />
        <span>{STATE_COPY[state]}</span>
      </div>
      {children}
    </div>
  );
}
