import * as React from "react";
import { AlertCircle, Clock, Archive } from "lucide-react";
import { cn } from "@sentinel-act/ui/lib/utils";
import type { UrgencyLevel } from "@sentinel-act/ui/lib/urgency";

/**
 * UrgencyBadge — the framework's Tier 1/2/3 info-hierarchy ("how soon
 * does a human need to look at this"), a completely different concept
 * from RiskTierBadge's A/B/C governance gate ("how much sign-off does
 * this need"). Per Spec 14 FR-7, this component MUST NOT reuse
 * `--risk-*` tokens, and MUST render a text label plus a distinct
 * Lucide icon per level — color alone is never the only signal
 * (WCAG 1.4.1, Spec 14 FR-6).
 *
 * Uses the same solid-fill + white-text treatment as RiskTierBadge (for
 * visual weight consistent with "escalation should look urgent, not
 * administrative" — UX brief §7) but with the separate `--urgency-*`
 * token group, so the two badges never visually blend even though they
 * share a shape.
 */

const LEVEL_LABEL: Record<UrgencyLevel, string> = {
  now: "Now",
  "in-motion": "In motion",
  archive: "Archive"
};

const LEVEL_CLASS: Record<UrgencyLevel, string> = {
  now: "bg-[hsl(var(--urgency-now))] text-white animate-pulse",
  "in-motion": "bg-[hsl(var(--urgency-in-motion))] text-white",
  archive: "bg-[hsl(var(--urgency-archive))] text-white"
};

const LEVEL_ICON: Record<UrgencyLevel, React.ComponentType<{ className?: string }>> = {
  now: AlertCircle,
  "in-motion": Clock,
  archive: Archive
};

export interface UrgencyBadgeProps {
  level: UrgencyLevel;
  /** Human-readable countdown/status, e.g. "Due in 2h 15m",
   *  "Breached 40m ago", "Decided 3 days ago". Required in practice for
   *  "now"/"in-motion" (Spec 14 FR-6 — a bare color dot is not
   *  acceptable); optional for "archive" where the label text itself is
   *  sufficient context. */
  detail?: string;
  className?: string;
}

export function UrgencyBadge({ level, detail, className }: UrgencyBadgeProps) {
  const Icon = LEVEL_ICON[level];
  const label = LEVEL_LABEL[level];
  const title = detail ? `${label} — ${detail}` : label;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold",
        LEVEL_CLASS[level],
        className
      )}
      title={title}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{detail ?? label}</span>
    </span>
  );
}
