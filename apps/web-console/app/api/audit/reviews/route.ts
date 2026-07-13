// Spec 10 §5.3 `GET /api/audit/reviews` — Observer mode's search screen.
// Read-only: the ONLY graph call this handler makes is
// `AuditQueryService.search` (FR-1's docstring: "This is the ONLY method
// apps/web-console's audit route handlers call for the search screen").
// No import of GraphWriter/commitProposal/any repository create()/
// supersede() method anywhere in this file (FR-21) — grep this file
// yourself before adding an import here.
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { AuditQueryService, getDriver } from "@sentinel-act/graph-db";
import type { AuditQueryFilters, AuditQueryResponse } from "@sentinel-act/graph-db";
import { mapAuditQueryError } from "@/lib/console/audit-errors";
import { jsonError, mapSessionError } from "@/lib/console/route-errors";
import { getReviewerSession, OBSERVER_MODE_ROLES, requireRole, requireSession } from "@/lib/console/session";

// NFR-2 / AuditQueryService's own MAX_PAGE_SIZE — duplicated as a literal
// here (not imported — AuditQueryService does not export it) purely so
// this route's own zod schema can reject an out-of-bound pageSize with a
// field-attributed 400 BEFORE AuditQueryService's defense-in-depth
// ValidationError throw ever fires (§8: "validated via a zod schema in
// the route handler ... validate before opening a session").
const MAX_PAGE_SIZE = 200;

function isIsoDateLike(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

// §4.1's AuditQueryFilters, as a zod schema over query-string values
// (every query param arrives as a string; page/pageSize are coerced to
// number). Mirrors queue/route.ts's parse-then-validate style (Spec 09)
// but via zod rather than hand-rolled parse functions, per this task's
// own instruction to use zod (already a dependency, unused elsewhere in
// this app until this stage).
const filtersQuerySchema = z.object({
  obligationId: z.string().trim().min(1).optional(),
  circularId: z.string().trim().min(1).optional(),
  reviewerId: z.string().trim().min(1).optional(),
  freeText: z.string().trim().min(1).optional(),
  tier: z.enum(["A", "B", "C"]).optional(),
  decision: z.enum(["approve", "reject"]).optional(),
  decidedFrom: z.string().refine(isIsoDateLike, "must be a valid ISO date").optional(),
  decidedTo: z.string().refine(isIsoDateLike, "must be a valid ISO date").optional(),
  page: z.coerce.number().int().min(1, "must be >= 1").optional(),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE, `must be <= ${MAX_PAGE_SIZE}`).optional()
});

const QUERY_KEYS = ["obligationId", "circularId", "reviewerId", "freeText", "tier", "decision", "decidedFrom", "decidedTo", "page", "pageSize"] as const;

function searchParamsToObject(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of QUERY_KEYS) {
    const value = url.searchParams.get(key);
    if (value !== null) {
      out[key] = value;
    }
  }
  return out;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const session = requireSession(await getReviewerSession(request));
    requireRole(session, OBSERVER_MODE_ROLES); // Observer mode / Compliance Register Export is compliance_head-exclusive — see OBSERVER_MODE_ROLES's own doc comment.

    const parsed = filtersQuerySchema.safeParse(searchParamsToObject(request.nextUrl));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      // §8 / §5.3: "400 { error, field } ... before any Cypher runs".
      return NextResponse.json({ error: issue.message, field: issue.path.join(".") || "unknown" }, { status: 400 });
    }

    const filters: AuditQueryFilters = parsed.data;
    const service = new AuditQueryService(getDriver());
    const response: AuditQueryResponse = await service.search(filters);
    return NextResponse.json(response, { status: 200 });
  } catch (err) {
    const sessionResponse = mapSessionError(err);
    if (sessionResponse) {
      return sessionResponse;
    }
    const auditResponse = mapAuditQueryError(err);
    if (auditResponse) {
      return auditResponse;
    }
    console.error(
      JSON.stringify({ ts: new Date().toISOString(), level: "error", operation: "GET /api/audit/reviews", message: err instanceof Error ? err.message : String(err) })
    );
    return jsonError(500, "INTERNAL_ERROR");
  }
}
