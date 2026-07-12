import * as React from "react";
import { cn } from "@sentinel-act/ui/lib/utils";

/**
 * ConfidenceBadge — surfaces Obligation.confidence_score /
 * grounding_score inline, not buried in a log. Implements framework
 * section 1 ("Confidence signaling at a glance"): a 95% result must
 * look and feel different from a 62% one via color and weight, not
 * just a number the reviewer has to interpret themselves.
 */

function bucket(score: number): "high" | "medium" | "low" {
  if (score >= 0.85) return "high";
  if (score >= 0.6) return "medium";
  return "low";
}

const BUCKET_CLASS = {
  high: "bg-[hsl(var(--confidence-high))]/15 text-[hsl(var(--confidence-high))] ring-1 ring-[hsl(var(--confidence-high))]/30",
  medium: "bg-[hsl(var(--confidence-medium))]/15 text-[hsl(var(--confidence-medium))] ring-1 ring-[hsl(var(--confidence-medium))]/30",
  low: "bg-[hsl(var(--confidence-low))]/15 text-[hsl(var(--confidence-low))] ring-1 ring-[hsl(var(--confidence-low))]/30"
} as const;

export function ConfidenceBadge({
  score,
  label = "Confidence",
  className
}: {
  score: number; // 0..1
  label?: string;
  className?: string;
}) {
  const b = bucket(score);
  const percent = Math.round(score * 100);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium",
        BUCKET_CLASS[b],
        className
      )}
      title={`${percent}% ${label}`}
    >
      <span className="font-semibold">{percent}%</span>
      <span className="opacity-80">{label}</span>
    </span>
  );
}
