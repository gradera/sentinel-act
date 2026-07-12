import * as React from "react";
import { AlertOctagon, Clock, AlertTriangle } from "lucide-react";
import { cn } from "@sentinel-act/ui/lib/utils";
import { Alert, AlertTitle, AlertDescription } from "@sentinel-act/ui/components/ui/alert";

/**
 * ExceptionAlert — the always-escalate / SLA-breach / warning surface
 * (UX brief §5 Journey D: "this state must look visually distinct... the
 * UI should make that structurally true, not just state it in a warning
 * banner"). For severity "escalate", this component's own
 * /dev/components example demonstrates `actions` containing only
 * "Escalate to Tier C" / "Reject" — but per Spec 14 FR-19, a caller
 * (Spec 09's `ContradictionPanel`) enforces the no-approve-action rule
 * by never passing an approve action into `actions` in the first place;
 * this component has no way to inspect the semantics of its own
 * `actions` children, so it cannot enforce that itself.
 */

export type ExceptionSeverity = "escalate" | "sla-breach" | "warning";

export interface ExceptionAlertProps {
  severity: ExceptionSeverity;
  title: string;
  description: React.ReactNode;
  /** Structured detail, e.g. a RedlineDiff comparing two conflicting
   *  Obligation field values for Journey D. Deliberately not a plain
   *  string — a vague "conflict detected" message is a design failure
   *  per the UX brief. */
  detail?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

const SEVERITY_CLASS: Record<ExceptionSeverity, string> = {
  escalate: "border-[hsl(var(--risk-escalate))] bg-[hsl(var(--risk-escalate))]/10 animate-pulse",
  "sla-breach": "border-[hsl(var(--risk-escalate))] bg-[hsl(var(--risk-escalate))]/10",
  warning: "border-[hsl(var(--confidence-medium))] bg-[hsl(var(--confidence-medium))]/10"
};

const SEVERITY_ICON: Record<ExceptionSeverity, React.ComponentType<{ className?: string }>> = {
  escalate: AlertOctagon,
  "sla-breach": Clock,
  warning: AlertTriangle
};

const SEVERITY_ICON_CLASS: Record<ExceptionSeverity, string> = {
  escalate: "text-[hsl(var(--risk-escalate))]",
  "sla-breach": "text-[hsl(var(--risk-escalate))]",
  warning: "text-[hsl(var(--confidence-medium))]"
};

export function ExceptionAlert({ severity, title, description, detail, actions, className }: ExceptionAlertProps) {
  const Icon = SEVERITY_ICON[severity];
  // FR-20: assertive role="alert" for escalate/sla-breach (interrupts a
  // screen-reader user the way it visually interrupts a sighted one),
  // polite role="status" for warning.
  const role = severity === "warning" ? "status" : "alert";

  return (
    <Alert
      role={role}
      variant={severity === "warning" ? "default" : "destructive"}
      className={cn(SEVERITY_CLASS[severity], className)}
      data-slot="exception-alert"
      data-severity={severity}
    >
      <Icon className={cn("h-4 w-4", SEVERITY_ICON_CLASS[severity])} aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <div>{description}</div>
        {detail && (
          <div className="mt-2" data-slot="exception-alert-detail">
            {detail}
          </div>
        )}
        {actions && (
          <div className="mt-3 flex flex-wrap gap-2" data-slot="exception-alert-actions">
            {actions}
          </div>
        )}
      </AlertDescription>
    </Alert>
  );
}
