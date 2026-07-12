import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@sentinel-act/ui/lib/utils";

/**
 * LineageBreadcrumb — Circular -> Clause -> Obligation -> ProcessTask
 * -> EvidenceArtifact, one click deep, per UX brief section 4 ("The
 * lineage") and design principle "Provenance over polish": every
 * claim on screen must trace to a literal source without a search.
 */

export interface LineageStep {
  label: string;
  href?: string;
}

export function LineageBreadcrumb({ steps, className }: { steps: LineageStep[]; className?: string }) {
  return (
    <nav className={cn("flex items-center flex-wrap gap-1 text-xs text-muted-foreground", className)} aria-label="Lineage">
      {steps.map((step, i) => (
        <React.Fragment key={`${step.label}-${i}`}>
          {i > 0 && <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />}
          {step.href ? (
            <a href={step.href} className="hover:text-foreground hover:underline">
              {step.label}
            </a>
          ) : (
            <span className="text-foreground font-medium">{step.label}</span>
          )}
        </React.Fragment>
      ))}
    </nav>
  );
}
