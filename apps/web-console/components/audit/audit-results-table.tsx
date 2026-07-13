"use client";

import * as React from "react";
import Link from "next/link";
import { LineageBreadcrumb } from "@sentinel-act/ui/components/governance/lineage-breadcrumb";
import { RiskTierBadge } from "@sentinel-act/ui/components/governance/risk-tier-badge";
import { DecisionBadge } from "@sentinel-act/ui/components/governance/decision-badge";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@sentinel-act/ui/components/ui/table";
import type { AuditQueryFilters, AuditQueryResponse, AuditTrailRow } from "@sentinel-act/graph-db";

/**
 * AuditResultsTable — Journey F's results view (Figma spec §10). Purely
 * read-only: no approve/reject/edit control, no `onClick`/form `action`
 * targeting any write-capable endpoint anywhere in this file (FR-20).
 *
 * FR-7 grouping approach: `AuditQueryResponse.rows` is a flat list sorted
 * by `decided_at` DESC across every obligation on the page — a Tier C
 * item's maker and checker rows are not guaranteed to be adjacent in that
 * list (other obligations' decisions may sort between them). This
 * component groups by scanning the whole page once: the first time a
 * Tier C row for a given `obligation_id` is seen, every Tier C row on the
 * page sharing that `obligation_id` is collected into one group (sorted
 * ascending by `decided_at`, matching `findByObligationId`'s own
 * ordering — FR-7) and rendered together under a single
 * "Tier C — N of 2 reviews" heading at that first-seen position; later
 * occurrences of the same obligation are skipped so it never renders
 * twice. Non-Tier-C rows render individually, in their original
 * position. Because the FR-11a guard already excludes an unresolved Tier
 * C/ESCALATE maker decision from `AuditQueryResponse` entirely, a
 * same-obligation Tier C group here is, by construction, never a partial
 * "1 of 2" reveal — see AuditQueryService's own doc comment.
 */

type DisplayGroup = { kind: "single"; row: AuditTrailRow } | { kind: "tier-c"; obligationId: string; rows: AuditTrailRow[] };

function buildGroups(rows: AuditTrailRow[]): DisplayGroup[] {
  const seen = new Set<string>();
  const groups: DisplayGroup[] = [];
  for (const row of rows) {
    if (row.review.tier === "C") {
      const obligationId = row.obligation.obligation_id;
      if (seen.has(obligationId)) {
        continue;
      }
      seen.add(obligationId);
      const rowsForObligation = rows
        .filter((r) => r.review.tier === "C" && r.obligation.obligation_id === obligationId)
        .sort((a, b) => new Date(a.review.decided_at).getTime() - new Date(b.review.decided_at).getTime());
      groups.push({ kind: "tier-c", obligationId, rows: rowsForObligation });
    } else {
      groups.push({ kind: "single", row });
    }
  }
  return groups;
}

function LineageOrUnavailable({ row }: { row: AuditTrailRow }) {
  // §8 "Partial/orphaned lineage data" — the OPTIONAL MATCH in §4.3
  // tolerates a missing DERIVED_FROM/PART_OF edge; render the row, not
  // omit it, but say plainly that lineage is missing rather than showing
  // a blank breadcrumb.
  if (!row.clause || !row.circular) {
    return <span className="text-xs italic text-muted-foreground">Source lineage unavailable</span>;
  }
  return (
    <LineageBreadcrumb
      steps={[{ label: row.circular.title }, { label: `Clause ${row.clause.para_ref}` }, { label: row.obligation.obligation_id }]}
    />
  );
}

function RationaleCell({ rationale }: { rationale: string | null }) {
  const [expanded, setExpanded] = React.useState(false);
  if (!rationale) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const isLong = rationale.length > 80;
  return (
    <div className="max-w-xs text-xs">
      <span>{expanded || !isLong ? rationale : `${rationale.slice(0, 80)}…`}</span>
      {isLong ? (
        <button type="button" className="ml-1 text-muted-foreground underline" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "less" : "more"}
        </button>
      ) : null}
    </div>
  );
}

function ReviewRow({ row, indent, label }: { row: AuditTrailRow; indent?: boolean; label?: string }) {
  return (
    <TableRow>
      <TableCell className={indent ? "pl-8" : undefined}>
        <div className="flex flex-col gap-1">
          {label ? <span className="text-xs font-medium text-muted-foreground">{label}</span> : null}
          <LineageOrUnavailable row={row} />
          <span className="text-xs text-muted-foreground">{row.obligation.requirement_text}</span>
        </div>
      </TableCell>
      <TableCell>
        <RiskTierBadge tier={row.review.tier} />
      </TableCell>
      <TableCell>
        <DecisionBadge decision={row.review.decision} />
      </TableCell>
      <TableCell className="text-xs">{row.review.reviewer_id}</TableCell>
      <TableCell>
        <RationaleCell rationale={row.review.rationale} />
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{new Date(row.review.decided_at).toLocaleString()}</TableCell>
    </TableRow>
  );
}

function paginationHref(filters: AuditQueryFilters, page: number): string {
  const params = new URLSearchParams();
  if (filters.obligationId) params.set("obligationId", filters.obligationId);
  if (filters.circularId) params.set("circularId", filters.circularId);
  if (filters.reviewerId) params.set("reviewerId", filters.reviewerId);
  if (filters.freeText) params.set("freeText", filters.freeText);
  if (filters.tier) params.set("tier", filters.tier);
  if (filters.decision) params.set("decision", filters.decision);
  if (filters.decidedFrom) params.set("decidedFrom", filters.decidedFrom);
  if (filters.decidedTo) params.set("decidedTo", filters.decidedTo);
  if (filters.pageSize) params.set("pageSize", String(filters.pageSize));
  params.set("page", String(page));
  return `/audit?${params.toString()}`;
}

export function AuditResultsTable({ response, filters }: { response: AuditQueryResponse; filters: AuditQueryFilters }) {
  const groups = React.useMemo(() => buildGroups(response.rows), [response.rows]);
  const totalPages = Math.max(1, Math.ceil(response.totalCount / response.pageSize));
  const rangeStart = response.rows.length === 0 ? 0 : (response.page - 1) * response.pageSize + 1;
  const rangeEnd = (response.page - 1) * response.pageSize + response.rows.length;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Showing {rangeStart}–{rangeEnd} of {response.totalCount}
      </p>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Obligation / Circular</TableHead>
            <TableHead>Tier</TableHead>
            <TableHead>Decision</TableHead>
            <TableHead>Reviewer</TableHead>
            <TableHead>Rationale</TableHead>
            <TableHead>Decided at</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {groups.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6}>
                <div className="flex flex-col items-center gap-1 py-12 text-center">
                  <p className="text-base font-medium">No matching HumanReview facts</p>
                  <p className="text-sm text-muted-foreground">Try widening a filter or clearing the search.</p>
                </div>
              </TableCell>
            </TableRow>
          ) : (
            groups.map((group) =>
              group.kind === "single" ? (
                <ReviewRow key={group.row.review.review_id} row={group.row} />
              ) : (
                <React.Fragment key={group.obligationId}>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableCell colSpan={6} className="text-xs font-semibold">
                      Tier C — {group.rows.length} of 2 reviews — Obligation {group.obligationId}
                    </TableCell>
                  </TableRow>
                  {group.rows.map((row, i) => (
                    <ReviewRow key={row.review.review_id} row={row} indent label={i === 0 ? "Maker" : "Checker"} />
                  ))}
                </React.Fragment>
              )
            )
          )}
        </TableBody>
      </Table>

      <div className="flex items-center justify-between text-xs">
        <Link
          href={paginationHref(filters, Math.max(1, response.page - 1))}
          aria-disabled={response.page <= 1}
          className={response.page <= 1 ? "pointer-events-none text-muted-foreground/50" : "text-muted-foreground underline"}
        >
          Previous
        </Link>
        <span className="text-muted-foreground">
          Page {response.page} of {totalPages}
        </span>
        <Link
          href={paginationHref(filters, Math.min(totalPages, response.page + 1))}
          aria-disabled={response.page >= totalPages}
          className={response.page >= totalPages ? "pointer-events-none text-muted-foreground/50" : "text-muted-foreground underline"}
        >
          Next
        </Link>
      </div>
    </div>
  );
}
