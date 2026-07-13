"use client";

import * as React from "react";
import { LineageBreadcrumb } from "@sentinel-act/ui/components/governance/lineage-breadcrumb";
import { ConfidenceBadge } from "@sentinel-act/ui/components/governance/confidence-badge";
import { RiskTierBadge } from "@sentinel-act/ui/components/governance/risk-tier-badge";
import { Skeleton } from "@sentinel-act/ui/components/ui/skeleton";
import { ContradictionPanel } from "@/components/console/ContradictionPanel";
import { ProcessTaskDiffView } from "@/components/console/ProcessTaskDiffView";
import { SignOffPanel } from "@/components/console/SignOffPanel";
import { SlaBanner } from "@/components/console/SlaBanner";
import { TierCGateBanner } from "@/components/console/TierCGateBanner";
import { consoleFetch } from "@/lib/console/client-fetch";
import type { ObligationDetailResponse } from "@/lib/console/types";

/**
 * Spec 09 screen 02 (+ its 03/04/05/06/07 wrappers) — the item detail
 * view. One component handles every tier/state combination by branching
 * on the real `ObligationDetailResponse` rather than having separate
 * screens per tier, since FR-9/10/11/12/14 apply identically regardless
 * of tier and only the sign-off/independence wrapper differs.
 */
export function ItemDetailClient({ obligationId }: { obligationId: string }) {
  const [detail, setDetail] = React.useState<ObligationDetailResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const res = await consoleFetch(`/api/console/items/${obligationId}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.message ?? `Unable to load this item (${res.status}).`);
        return;
      }
      setDetail((await res.json()) as ObligationDetailResponse);
    } catch {
      setError("Network error — unable to load this item.");
    }
  }, [obligationId]);

  React.useEffect(() => {
    setDetail(null);
    void load();
  }, [load]);

  if (error) {
    return (
      <main className="mx-auto max-w-5xl space-y-4 p-8">
        <p className="text-sm text-destructive">{error}</p>
      </main>
    );
  }

  if (!detail) {
    return (
      <main className="mx-auto max-w-5xl space-y-6 p-8">
        <Skeleton className="h-4 w-64" />
        <div className="grid gap-6 md:grid-cols-2">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
        <Skeleton className="h-40 w-full" />
      </main>
    );
  }

  const { obligation } = detail;
  const signOffPanel = (
    <SignOffPanel obligationId={obligationId} reviewGate={detail.reviewGate} reviewGateUnavailable={detail.reviewGateUnavailable} onSubmitted={load} />
  );

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-8">
      <LineageBreadcrumb steps={detail.lineage} />

      <div className="flex items-center gap-2">
        <RiskTierBadge tier={detail.tier} />
      </div>

      {/* FR-29: visible, non-dismissable — ExceptionAlert/Alert render no
          close affordance at all, so this cannot be dismissed by the reviewer. */}
      <SlaBanner slaState={detail.slaState} slaDueAt={detail.slaDueAt} escalationReason={detail.escalationReason} />

      {/* FR-16: contradiction panel renders ABOVE the normal panels, at
          highest visual priority, but the normal panels still render
          alongside it (not instead of it) — a reviewer resolving an
          escalation still needs the full source-to-task context. */}
      {detail.tier === "ESCALATE" && detail.contradiction !== null && <ContradictionPanel contradiction={detail.contradiction} />}

      <div className="grid gap-6 md:grid-cols-2">
        {/* FR-9: literal, unmodified source clause — visually distinct
            "quote" treatment, never mistaken for the extracted fields
            beside it. */}
        <section className="rounded-lg border bg-muted/30 p-4" data-slot="source-clause-card">
          <h2 className="mb-2 text-sm font-semibold">{detail.sourceCircular.title}</h2>
          <p className="mb-3 text-xs text-muted-foreground">Clause {detail.sourceClause.paraRef}</p>
          <blockquote className="border-l-2 border-muted-foreground/40 pl-3 text-sm italic text-foreground">
            {detail.sourceClause.text}
          </blockquote>
        </section>

        {/* FR-10: exactly these Obligation fields, no others. */}
        <section className="rounded-lg border bg-card p-4" data-slot="obligation-fields-card">
          <h2 className="mb-2 text-sm font-semibold">Extracted obligation</h2>
          <dl className="space-y-2 text-sm">
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Requirement</dt>
              <dd>{obligation.requirement_text}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Trigger event</dt>
              <dd>{obligation.trigger_event}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Deadline rule</dt>
              <dd>{obligation.deadline_rule}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Responsible role</dt>
              <dd>{obligation.responsible_role}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Penalty reference</dt>
              <dd>{obligation.penalty_ref ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Status</dt>
              <dd>{obligation.status}</dd>
            </div>
            <div className="flex gap-2 pt-1">
              <ConfidenceBadge score={obligation.confidence_score} />
              <ConfidenceBadge score={obligation.grounding_score} label="Grounding" />
            </div>
          </dl>
        </section>
      </div>

      <ProcessTaskDiffView processTaskDiff={detail.processTaskDiff} />

      <div>
        {detail.reviewGate.kind === "tier_c" ? (
          <TierCGateBanner reviewGate={detail.reviewGate}>{signOffPanel}</TierCGateBanner>
        ) : (
          signOffPanel
        )}
      </div>
    </main>
  );
}
