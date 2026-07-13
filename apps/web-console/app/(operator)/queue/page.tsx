"use client";

import * as React from "react";
import Link from "next/link";
import { RiskTierBadge } from "@sentinel-act/ui/components/governance/risk-tier-badge";
import { ConfidenceBadge } from "@sentinel-act/ui/components/governance/confidence-badge";
import { Avatar, AvatarFallback } from "@sentinel-act/ui/components/ui/avatar";
import { Button } from "@sentinel-act/ui/components/ui/button";
import { Skeleton } from "@sentinel-act/ui/components/ui/skeleton";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@sentinel-act/ui/components/ui/table";
import { SlaBanner } from "@/components/console/SlaBanner";
import { consoleFetch } from "@/lib/console/client-fetch";
import type { ObligationStatus, QueueItemSummary, QueueListResponse } from "@/lib/console/types";

// Journey A / B entry point (UX brief §5): reviewer queue, sorted by risk
// score and time-to-SLA server-side (sla.ts's `compareQueueItems`), not
// arrival order — "a reviewer's first question is always 'what's about
// to breach'". Tier A never appears here (auto-commits, FR-1).

type TierFilter = "B" | "C" | "ESCALATE";

const ALL_TIERS: TierFilter[] = ["B", "C", "ESCALATE"];
const TIER_LABEL: Record<TierFilter, string> = { B: "Tier B", C: "Tier C", ESCALATE: "Escalated" };

const ALL_STATUSES: ObligationStatus[] = ["tier_b_review", "tier_c_review", "escalated"];
const STATUS_LABEL: Record<string, string> = {
  tier_b_review: "Awaiting Tier B review",
  tier_c_review: "Awaiting Tier C review",
  escalated: "Escalated"
};

function initials(id: string): string {
  const [name] = id.split("@");
  return name.slice(0, 2).toUpperCase();
}

export default function QueuePage() {
  const [items, setItems] = React.useState<QueueItemSummary[] | null>(null);
  const [orchestratorUnavailable, setOrchestratorUnavailable] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [tierFilter, setTierFilter] = React.useState<Set<TierFilter>>(new Set(ALL_TIERS));
  const [statusFilter, setStatusFilter] = React.useState<Set<ObligationStatus>>(new Set(ALL_STATUSES));

  const load = React.useCallback(async () => {
    setLoadError(null);
    try {
      const params = new URLSearchParams();
      if (tierFilter.size > 0 && tierFilter.size < ALL_TIERS.length) {
        params.set("tiers", Array.from(tierFilter).join(","));
      }
      if (statusFilter.size > 0 && statusFilter.size < ALL_STATUSES.length) {
        params.set("statuses", Array.from(statusFilter).join(","));
      }
      const res = await consoleFetch(`/api/console/queue?${params.toString()}`);
      if (!res.ok) {
        setLoadError(`Unable to load the queue (${res.status}).`);
        setItems([]);
        return;
      }
      const body = (await res.json()) as QueueListResponse;
      setItems(body.items);
      setOrchestratorUnavailable(body.orchestratorUnavailable);
    } catch {
      setLoadError("Network error — unable to load the queue.");
      setItems([]);
    }
  }, [tierFilter, statusFilter]);

  React.useEffect(() => {
    setItems(null); // FR: skeleton on every refetch, immediately, no delay
    void load();
  }, [load]);

  function toggleTier(tier: TierFilter) {
    setTierFilter((prev) => {
      const next = new Set(prev);
      if (next.has(tier)) next.delete(tier);
      else next.add(tier);
      return next.size === 0 ? new Set(ALL_TIERS) : next;
    });
  }

  function toggleStatus(status: ObligationStatus) {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next.size === 0 ? new Set(ALL_STATUSES) : next;
    });
  }

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Reviewer queue — Operator mode</h1>
      </div>

      <div className="flex flex-wrap items-center gap-4 rounded-lg border bg-card p-3 text-sm">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Tier</span>
          {ALL_TIERS.map((tier) => (
            <Button key={tier} type="button" size="sm" variant={tierFilter.has(tier) ? "secondary" : "outline"} onClick={() => toggleTier(tier)}>
              {TIER_LABEL[tier]}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Status</span>
          {ALL_STATUSES.map((status) => (
            <Button key={status} type="button" size="sm" variant={statusFilter.has(status) ? "secondary" : "outline"} onClick={() => toggleStatus(status)}>
              {STATUS_LABEL[status]}
            </Button>
          ))}
        </div>
      </div>

      {orchestratorUnavailable && (
        <p className="rounded-md border border-[hsl(var(--confidence-medium))]/40 bg-[hsl(var(--confidence-medium))]/10 px-3 py-2 text-sm">
          Review-gate status is temporarily unavailable for some items — the list below is still current, but Tier C
          claim/SLA state may not reflect the latest activity.
        </p>
      )}
      {loadError && <p className="text-sm text-destructive">{loadError}</p>}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Obligation (risk score ↓)</TableHead>
            <TableHead>Tier</TableHead>
            <TableHead>Urgency (SLA ↑)</TableHead>
            <TableHead>Confidence</TableHead>
            <TableHead>Assigned</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items === null ? (
            Array.from({ length: 5 }).map((_, i) => (
              <TableRow key={i}>
                {Array.from({ length: 6 }).map((__, j) => (
                  <TableCell key={j}>
                    <Skeleton className="h-5 w-full max-w-[160px]" />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : items.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6}>
                <div className="flex flex-col items-center gap-1 py-12 text-center">
                  <p className="text-base font-medium">Queue clear</p>
                  <p className="text-sm text-muted-foreground">Nothing is waiting on a reviewer right now.</p>
                </div>
              </TableCell>
            </TableRow>
          ) : (
            items.map((item) => (
              <TableRow key={item.obligationId} data-escalated={item.isEscalated}>
                <TableCell>
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium">{item.summary}</span>
                    <span className="text-xs text-muted-foreground">
                      {item.category} · {item.circularTitle}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <RiskTierBadge tier={item.tier} />
                </TableCell>
                <TableCell>
                  <SlaBanner slaState={item.slaState} slaDueAt={item.slaDueAt} escalationReason={item.escalationReason} variant="inline" />
                </TableCell>
                <TableCell>
                  <ConfidenceBadge score={item.confidenceScore} />
                </TableCell>
                <TableCell>
                  {item.assignedReviewerId ? (
                    <div className="flex items-center gap-2">
                      <Avatar className="h-6 w-6">
                        <AvatarFallback>{initials(item.assignedReviewerId)}</AvatarFallback>
                      </Avatar>
                      <span className="text-xs">{item.assignedReviewerId}</span>
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">Unassigned</span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/queue/${item.obligationId}`}>Open</Link>
                  </Button>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </main>
  );
}
