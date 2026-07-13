"use client";

import * as React from "react";
import type { AuditQueryFilters } from "@sentinel-act/graph-db";

const inputClass =
  "h-9 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/**
 * AuditFilterBar — Journey F's query form (UX brief §5: "a query
 * interface, not a document, treat it like a filterable log/table").
 * Every `AuditQueryFilters` field (§4.1) as a plain input.
 *
 * URL-update mechanism: a plain `<form method="GET">`, deliberately
 * chosen over `useRouter`/`usePathname`/`useSearchParams` client-side
 * push. `apps/web-console/app/(observer)/audit/page.tsx` is a Server
 * Component that reads `searchParams` directly and calls
 * `AuditQueryService.search` server-side (no client fetch on initial
 * load) — a native GET-form submission is the simplest mechanism that
 * keeps the URL as the single source of truth for what was searched
 * (linkable/bookmarkable, per this component's own spec), with no risk
 * of client-rendered filter state drifting from what the server actually
 * queried, and no debounce/router-push plumbing needed for a single
 * "Search" submit. Free-text debouncing (mentioned in this component's
 * own task brief as a requirement "if using client-side interactivity")
 * does not apply here for the same reason: nothing auto-submits on
 * keystroke, so there is nothing to debounce.
 *
 * Submitting this form intentionally does NOT carry the current `page`
 * query param forward — a new search always starts back at page 1,
 * which is the correct behavior for a changed filter set. `pageSize` is
 * carried forward as its own field so a chosen page size persists across
 * searches.
 */
export function AuditFilterBar({ filters }: { filters: AuditQueryFilters }) {
  return (
    <form method="GET" className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3 text-sm">
      <div className="flex flex-col gap-1">
        <label htmlFor="obligationId" className="text-xs font-medium text-muted-foreground">
          Obligation ID
        </label>
        <input id="obligationId" name="obligationId" defaultValue={filters.obligationId ?? ""} className={inputClass} placeholder="OBL-..." />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="circularId" className="text-xs font-medium text-muted-foreground">
          Circular ID
        </label>
        <input id="circularId" name="circularId" defaultValue={filters.circularId ?? ""} className={inputClass} placeholder="CIR-..." />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="reviewerId" className="text-xs font-medium text-muted-foreground">
          Reviewer
        </label>
        <input id="reviewerId" name="reviewerId" defaultValue={filters.reviewerId ?? ""} className={inputClass} placeholder="reviewer@example.com" />
      </div>

      <div className="flex min-w-[220px] flex-1 flex-col gap-1">
        <label htmlFor="freeText" className="text-xs font-medium text-muted-foreground">
          Free text (requirement, circular title, para ref)
        </label>
        <input id="freeText" name="freeText" defaultValue={filters.freeText ?? ""} className={inputClass} placeholder="Search..." />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="tier" className="text-xs font-medium text-muted-foreground">
          Tier
        </label>
        <select id="tier" name="tier" defaultValue={filters.tier ?? ""} className={inputClass}>
          <option value="">Any</option>
          <option value="A">Tier A (always 0 rows — no human review)</option>
          <option value="B">Tier B</option>
          <option value="C">Tier C</option>
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="decision" className="text-xs font-medium text-muted-foreground">
          Decision
        </label>
        <select id="decision" name="decision" defaultValue={filters.decision ?? ""} className={inputClass}>
          <option value="">Any</option>
          <option value="approve">Approved</option>
          <option value="reject">Rejected</option>
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="decidedFrom" className="text-xs font-medium text-muted-foreground">
          Decided from
        </label>
        <input id="decidedFrom" type="date" name="decidedFrom" defaultValue={filters.decidedFrom ?? ""} className={inputClass} />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="decidedTo" className="text-xs font-medium text-muted-foreground">
          Decided to
        </label>
        <input id="decidedTo" type="date" name="decidedTo" defaultValue={filters.decidedTo ?? ""} className={inputClass} />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="pageSize" className="text-xs font-medium text-muted-foreground">
          Page size
        </label>
        <select id="pageSize" name="pageSize" defaultValue={String(filters.pageSize ?? 50)} className={inputClass}>
          <option value="25">25</option>
          <option value="50">50</option>
          <option value="100">100</option>
          <option value="200">200</option>
        </select>
      </div>

      {/* No primary-color CTA on this screen (Figma spec §10) — a plain
          bordered button, not the operator queue's <Button variant="default">
          treatment. */}
      <button type="submit" className="h-9 rounded-md border border-input bg-secondary px-4 text-sm font-medium text-secondary-foreground hover:bg-secondary/80">
        Search
      </button>
      <a href="/audit" className="text-xs text-muted-foreground underline-offset-2 hover:underline">
        Clear filters
      </a>
    </form>
  );
}
