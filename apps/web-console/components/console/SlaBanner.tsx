import { ExceptionAlert } from "@sentinel-act/ui/components/governance/exception-alert";
import { UrgencyBadge } from "@sentinel-act/ui/components/governance/urgency-badge";
import type { UrgencyLevel } from "@sentinel-act/ui/lib/urgency";
import type { SlaState } from "@/lib/console/types";

/**
 * SlaBanner — Spec 09 screen 08 (FR-29). Two distinct states, per the
 * Figma spec's screen 08 states list:
 *
 *  - approaching-breach: "the in-app equivalent of the Slack SLA
 *    reminder — UrgencyBadge level `now`, not yet reassigned." Loud but
 *    not yet an exception.
 *  - breached + reassigned: `escalationReason` is non-null
 *    (`"SLA missed, reassigned from {previous reviewer name}"`, verbatim
 *    from the BFF per FR-29) — this is a real exception, rendered via
 *    `ExceptionAlert` severity `"sla-breach"`. `ExceptionAlert`/`Alert`
 *    render no close affordance at all, so this is non-dismissable by
 *    construction, matching FR-29's "visible, non-dismissable banner"
 *    requirement without needing a separate dismiss-guard.
 *
 * `SlaState` ("ok"/"due_soon"/"breached", types.ts) is a deliberately
 * different vocabulary from `UrgencyBadge`'s `UrgencyLevel`
 * ("now"/"in-motion"/"archive") — sla.ts's own doc comment names this
 * component as the one place that has to write the `SlaState ->
 * UrgencyLevel` mapping; `slaStateToUrgencyLevel` below is that mapping,
 * not a re-derivation of sla.ts's threshold math itself.
 *
 * `variant="inline"` renders just the compact `UrgencyBadge`/badge-sized
 * exception tag (for a queue table cell); the default `"banner"` renders
 * the full-width top-of-page treatment (for the item detail view).
 */

export type SlaBannerVariant = "banner" | "inline";

export interface SlaBannerProps {
  slaState: SlaState;
  slaDueAt: string | null;
  /** Non-null only for the breach+reassignment case (FR-29) — see
   *  `ObligationDetailResponse.escalationReason` / `QueueItemSummary.escalationReason`. */
  escalationReason: string | null;
  variant?: SlaBannerVariant;
  className?: string;
}

function slaStateToUrgencyLevel(slaState: SlaState): UrgencyLevel {
  switch (slaState) {
    case "ok":
      return "in-motion";
    case "due_soon":
    case "breached":
      // Both map to "now": a miss must read as loud "now", not merely
      // re-sorted (mirrors computeUrgency's own documented edge case).
      return "now";
  }
}

function formatDueDetail(slaDueAt: string | null, slaState: SlaState): string | undefined {
  if (slaDueAt === null) {
    return slaState === "breached" ? "SLA breached" : undefined;
  }
  const diffMs = new Date(slaDueAt).getTime() - Date.now();
  const absMinutes = Math.round(Math.abs(diffMs) / 60000);
  const hours = Math.floor(absMinutes / 60);
  const minutes = absMinutes % 60;
  const span = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  return diffMs <= 0 ? `Breached ${span} ago` : `Due in ${span}`;
}

export function SlaBanner({ slaState, slaDueAt, escalationReason, variant = "banner", className }: SlaBannerProps) {
  if (escalationReason !== null) {
    if (variant === "inline") {
      return <UrgencyBadge level="now" detail="Reassigned — SLA missed" className={className} />;
    }
    return (
      <ExceptionAlert
        severity="sla-breach"
        title={escalationReason}
        description="This item missed its review SLA and has been reassigned to you. Review it as a priority — the summary below is here so you don't have to read the full detail view from scratch."
        className={className}
      />
    );
  }

  if (slaState === "ok") {
    return null;
  }

  return <UrgencyBadge level={slaStateToUrgencyLevel(slaState)} detail={formatDueDetail(slaDueAt, slaState)} className={className} />;
}
