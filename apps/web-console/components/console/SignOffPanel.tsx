"use client";

import * as React from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter } from "@sentinel-act/ui/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel
} from "@sentinel-act/ui/components/ui/alert-dialog";
import { Button } from "@sentinel-act/ui/components/ui/button";
import { Label } from "@sentinel-act/ui/components/ui/label";
import { Textarea } from "@sentinel-act/ui/components/ui/textarea";
import { consoleFetch } from "@/lib/console/client-fetch";
import type { DecisionAction, ReviewGateView, SubmitDecisionResponse } from "@/lib/console/types";

/**
 * SignOffPanel — Spec 09 screen 03 (+ its ESCALATE variant, screen 07's
 * action set). A `Sheet`, not a `Dialog`, so the source/Obligation
 * comparison behind it stays visible while deciding (UX brief §5).
 *
 * Action set by `reviewGate.kind`:
 *  - "tier_b": Approve / Decline, rationale optional (FR-17).
 *  - "tier_c": Approve / Decline, rationale required non-empty (FR-25).
 *    Claiming a slot (FR-19/20) happens automatically, before the sheet
 *    opens, when `status === "unclaimed"` — `POST .../claim` first, then
 *    open only on success.
 *  - "escalate": Escalate to Tier C / Reject — "approve" is structurally
 *    absent from this component's own action-set builder for this kind,
 *    not merely disabled (FR-27); rationale required (FR-25 extends to
 *    ESCALATE per `EscalateReviewGateView.rationaleRequired: true`).
 *
 * Decline/Reject routes through an `AlertDialog` confirmation. Escape/
 * outside-click with uncommitted rationale text routes through
 * `SheetContent`'s own `hasUnsavedChanges` discard-confirm (same pattern
 * as the `/dev/components` sign-off sheet demo).
 *
 * `reviewGateUnavailable` (Spec 09 §8's degraded-read row) disables every
 * decision action and shows an explicit "status unavailable" notice —
 * this protects the Tier C independence guarantee itself, since a
 * degraded read is exactly the condition under which a stale/incorrect
 * gate state would be dangerous to act on.
 *
 * This component submits directly to this app's own BFF route via
 * client-side `fetch` (`consoleFetch`) rather than a Next.js Server
 * Action — that route is not the security-sensitive one (`GET .../items/
 * :id` already merges the review gate server-side; NFR-Security-1 lives
 * there, not here), and no other mutation in this app uses Server
 * Actions, so plain client fetch matches the app's own convention.
 */

export interface SignOffPanelProps {
  obligationId: string;
  reviewGate: ReviewGateView;
  reviewGateUnavailable: boolean;
  onSubmitted?: (response: SubmitDecisionResponse) => void;
}

interface ActionSpec {
  decision: DecisionAction;
  label: string;
  variant: "default" | "destructive" | "outline";
  requiresConfirm: boolean;
}

function actionsFor(reviewGate: ReviewGateView): ActionSpec[] {
  if (reviewGate.kind === "escalate") {
    // FR-27: no "approve" entry exists in this array at all.
    return [
      { decision: "escalate_to_tier_c", label: "Escalate to Tier C", variant: "default", requiresConfirm: false },
      { decision: "reject", label: "Reject", variant: "destructive", requiresConfirm: true }
    ];
  }
  return [
    { decision: "approve", label: "Approve", variant: "default", requiresConfirm: false },
    { decision: "reject", label: "Decline", variant: "destructive", requiresConfirm: true }
  ];
}

export function SignOffPanel({ obligationId, reviewGate, reviewGateUnavailable, onSubmitted }: SignOffPanelProps) {
  const [open, setOpen] = React.useState(false);
  const [rationale, setRationale] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [claiming, setClaiming] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmDecision, setConfirmDecision] = React.useState<DecisionAction | null>(null);

  const hasUnsavedChanges = rationale.trim().length > 0;

  // Tier C: no form to offer once the viewer has already submitted or
  // both slots have resolved — TierCGateBanner/IndependenceGate around
  // this component already renders the correct locked/revealed state for
  // that case (screens 04/06).
  if (reviewGate.kind === "tier_c" && reviewGate.status !== "unclaimed" && reviewGate.status !== "claimed_by_viewer") {
    return null;
  }

  // Tier B / ESCALATE: already decided by this viewer — read-only
  // confirmation, no form.
  if (reviewGate.kind !== "tier_c" && reviewGate.existingDecision !== null) {
    const decision = reviewGate.existingDecision;
    return (
      <div className="rounded-lg border bg-card p-4 text-sm" data-slot="sign-off-panel-decided">
        <p className="font-medium">You {decision.decision === "approve" ? "approved" : "rejected"} this item.</p>
        <p className="mt-1 text-xs text-muted-foreground">{new Date(decision.decided_at).toLocaleString()}</p>
        {decision.rationale && <p className="mt-2 text-foreground">{decision.rationale}</p>}
      </div>
    );
  }

  const rationaleRequired = reviewGate.rationaleRequired;
  const actions = actionsFor(reviewGate);
  const needsClaimFirst = reviewGate.kind === "tier_c" && reviewGate.status === "unclaimed";

  async function claimThenOpen() {
    setError(null);
    setClaiming(true);
    try {
      const res = await consoleFetch(`/api/console/items/${obligationId}/claim`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.message ?? `Unable to claim this item (${res.status}).`);
        return;
      }
      setOpen(true);
    } catch {
      setError("Network error — could not claim this item, please retry.");
    } finally {
      setClaiming(false);
    }
  }

  async function submit(decision: DecisionAction) {
    setError(null);
    setSubmitting(true);
    try {
      const res = await consoleFetch(`/api/console/items/${obligationId}/decisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, rationale: rationale.trim().length > 0 ? rationale.trim() : null })
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.message ?? `Unable to submit decision (${res.status}).`);
        return;
      }
      setRationale("");
      setOpen(false);
      setConfirmDecision(null);
      onSubmitted?.(body as SubmitDecisionResponse);
    } catch {
      setError("Network error — your decision was not recorded, please retry.");
    } finally {
      setSubmitting(false);
    }
  }

  const submitDisabled = submitting || reviewGateUnavailable || (rationaleRequired && rationale.trim().length === 0);

  return (
    <>
      <Button type="button" onClick={needsClaimFirst ? claimThenOpen : () => setOpen(true)} disabled={claiming}>
        {needsClaimFirst ? (claiming ? "Claiming…" : "Claim & review") : "Sign off"}
      </Button>
      {error && !open && <p className="mt-2 text-sm text-destructive">{error}</p>}

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent hasUnsavedChanges={hasUnsavedChanges}>
          <SheetHeader>
            <SheetTitle>Sign off — {reviewGate.kind === "tier_c" ? "Tier C" : reviewGate.kind === "escalate" ? "Always-escalate" : "Tier B"}</SheetTitle>
            <SheetDescription>
              {reviewGate.kind === "tier_c" && "This requires a second, independent approval. The other reviewer's decision is hidden until you submit yours."}
              {reviewGate.kind === "escalate" && "This item conflicts with an existing obligation. Approve is not available here — escalate it for a second review, or reject it."}
              {reviewGate.kind === "tier_b" && "Rationale is optional but encouraged."}
            </SheetDescription>
          </SheetHeader>

          {reviewGateUnavailable && (
            <div className="mx-4 rounded-md border border-[hsl(var(--confidence-medium))]/40 bg-[hsl(var(--confidence-medium))]/10 p-3 text-sm">
              Review status is currently unavailable. Decisions are disabled until this is resolved — please retry shortly.
            </div>
          )}

          <div className="grid gap-2 px-4">
            <Label htmlFor="sign-off-rationale">
              Rationale {rationaleRequired && <span aria-hidden="true">*</span>}
            </Label>
            <Textarea
              id="sign-off-rationale"
              placeholder="Explain your decision..."
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              disabled={reviewGateUnavailable || submitting}
              aria-required={rationaleRequired}
            />
            {rationaleRequired && (
              <p className="text-xs text-muted-foreground">Rationale is required before you can submit this decision.</p>
            )}
          </div>

          {error && <p className="px-4 text-sm text-destructive">{error}</p>}

          <SheetFooter>
            {actions.map((action) => (
              <Button
                key={action.decision}
                type="button"
                variant={action.variant}
                disabled={submitDisabled}
                onClick={() => (action.requiresConfirm ? setConfirmDecision(action.decision) : submit(action.decision))}
              >
                {submitting ? "Submitting…" : action.label}
              </Button>
            ))}
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmDecision !== null} onOpenChange={(next) => !next && setConfirmDecision(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm rejection</AlertDialogTitle>
            <AlertDialogDescription>This will record a rejection decision for this obligation. This cannot be undone from this screen.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setConfirmDecision(null)}>Keep reviewing</AlertDialogCancel>
            <AlertDialogAction disabled={submitting} onClick={() => confirmDecision && submit(confirmDecision)}>
              {submitting ? "Submitting…" : "Confirm reject"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
