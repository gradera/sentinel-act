import { AuditQueryService, getDriver } from "@sentinel-act/graph-db";
import type { AuditQueryFilters, AuditQueryResponse } from "@sentinel-act/graph-db";
import { ReadOnlyBanner } from "@sentinel-act/ui/components/governance/read-only-banner";
import { AuditFilterBar } from "@/components/audit/audit-filter-bar";
import { AuditResultsTable } from "@/components/audit/audit-results-table";
import { ExportPanel } from "@/components/audit/export-panel";

// Journey F (UX brief §5): a searchable, filterable log/table over every
// HumanReview fact — not a document, a query interface. This page is a
// Server Component: it calls AuditQueryService.search directly (same
// pattern app/api/audit/reviews/route.ts itself uses — construct
// getDriver() + new AuditQueryService(driver) right here) rather than
// fetching its own API route, so the initial render needs no network hop.
//
// Next.js 15 hands Server Components an async `searchParams` (a Promise)
// — same convention already used by
// app/(operator)/queue/[obligationId]/page.tsx's `params`.
type RawSearchParams = Record<string, string | string[] | undefined>;

const VALID_TIERS = new Set(["A", "B", "C"]);
const VALID_DECISIONS = new Set(["approve", "reject"]);
const MAX_PAGE_SIZE = 200;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** Parses raw `searchParams` into `AuditQueryFilters` (§4.1), silently
 *  dropping an invalid enum/number value rather than erroring the page —
 *  this is a best-effort initial-render parse, not the route handler's
 *  own zod 400 validation (which still applies to any client-side call
 *  the export panel makes to `/api/audit/export`). */
function parseFilters(sp: RawSearchParams): AuditQueryFilters {
  const tierRaw = first(sp.tier);
  const decisionRaw = first(sp.decision);
  const pageRaw = Number(first(sp.page));
  const pageSizeRaw = Number(first(sp.pageSize));

  return {
    obligationId: nonEmpty(first(sp.obligationId)),
    circularId: nonEmpty(first(sp.circularId)),
    reviewerId: nonEmpty(first(sp.reviewerId)),
    freeText: nonEmpty(first(sp.freeText)),
    tier: tierRaw && VALID_TIERS.has(tierRaw) ? (tierRaw as AuditQueryFilters["tier"]) : undefined,
    decision: decisionRaw && VALID_DECISIONS.has(decisionRaw) ? (decisionRaw as AuditQueryFilters["decision"]) : undefined,
    decidedFrom: nonEmpty(first(sp.decidedFrom)),
    decidedTo: nonEmpty(first(sp.decidedTo)),
    page: Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : undefined,
    pageSize: Number.isFinite(pageSizeRaw) && pageSizeRaw >= 1 ? Math.min(Math.floor(pageSizeRaw), MAX_PAGE_SIZE) : undefined
  };
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const rawSearchParams = await searchParams;
  const filters = parseFilters(rawSearchParams);

  let response: AuditQueryResponse | null = null;
  let loadError: string | null = null;
  try {
    const service = new AuditQueryService(getDriver());
    response = await service.search(filters);
  } catch (err) {
    // §8: "the UI shows a distinct 'can't reach the audit log right now'
    // state (not a blank table, not a silent empty result)".
    loadError = err instanceof Error ? err.message : "search temporarily unavailable";
  }

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-8">
      <ReadOnlyBanner title="Observer mode — read only">
        Search, filter, and export the HumanReview trail below. This persona never approves, rejects, or edits
        anything — every control on this screen is a filter/search input or an export trigger, per the Compliance
        Head / auditor persona's own definition (UX brief §5, Journey F).
      </ReadOnlyBanner>

      <h1 className="text-lg font-semibold">Audit lookup — Observer mode</h1>

      <AuditFilterBar filters={filters} />

      {loadError ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Can&apos;t reach the audit log right now. This is not the same as &quot;there is nothing to see&quot; — please
          retry shortly. ({loadError})
        </p>
      ) : (
        <AuditResultsTable response={response as AuditQueryResponse} filters={filters} />
      )}

      <ExportPanel filters={filters} />
    </main>
  );
}
