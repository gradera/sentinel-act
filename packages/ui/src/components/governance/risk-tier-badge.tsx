import * as React from "react";
import { cn } from "@sentinel-act/ui/lib/utils";
import type { ReviewTier } from "@sentinel-act/graph-schema";

/**
 * RiskTierBadge — makes the governance gate (Tier A/B/C, or an
 * always-escalate state) unmissable at a glance, per the UX brief
 * principle "make the tier and the reason for the tier unmissable"
 * and the framework's "Trust Gradient" section (confidence signaling
 * at a glance, distinguish action types by risk level).
 *
 * This is intentionally a *risk* tier, not the framework's Tier 1/2/3
 * urgency hierarchy (see UrgencyBadge) — the two must never be
 * visually or semantically conflated on the same screen.
 */

type Tier = ReviewTier | "ESCALATE";

const TIER_LABEL: Record<Tier, string> = {
  A: "Tier A · Auto-commit",
  B: "Tier B · Single reviewer",
  C: "Tier C · Maker-checker",
  ESCALATE: "Always-escalate"
};

const TIER_CLASS: Record<Tier, string> = {
  A: "bg-[hsl(var(--risk-a))] text-white",
  B: "bg-[hsl(var(--risk-b))] text-white",
  C: "bg-[hsl(var(--risk-c))] text-white",
  ESCALATE: "bg-[hsl(var(--risk-escalate))] text-white animate-pulse"
};

export function RiskTierBadge({ tier, className }: { tier: Tier; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold",
        TIER_CLASS[tier],
        className
      )}
      title={TIER_LABEL[tier]}
    >
      {TIER_LABEL[tier]}
    </span>
  );
}
