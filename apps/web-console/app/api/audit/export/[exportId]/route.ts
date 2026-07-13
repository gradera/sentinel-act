// Spec 10 §5.5 `GET /api/audit/export/:exportId` — the async-path poll
// target (FR-13). Read-only against the Regulatory Knowledge Graph
// (FR-21); the only graph call is `ExportJobStore.find` (plus, on the §8
// stale-job lazy-flip below, `ExportJobStore.markFailed` — the same
// documented `:ExportJob`-bookkeeping write exception every other route
// in this tree relies on).
//
// ***** Ownership decision (documented, not specified verbatim by the
// ***** spec) *****
// Any authenticated Observer-mode caller (OBSERVER_MODE_ROLES) may look
// up ANY export job by id, not just ones they themselves requested. This
// mirrors NFR-6's own reasoning for `reviewer_id` display ("this unit
// does not join against any additional identity/directory service ...
// consistent with this being an internal, professional-persona-only
// tool") — a :ExportJob's own fields (asOfDate/format/filters/rowCount/
// requestedBy) are no more sensitive than what the audit search screen
// itself already exposes to the same role, so per-requester ownership
// filtering would add complexity without a corresponding confidentiality
// gain. If a future stage decides otherwise, add a
// `job.requestedBy === session.reviewerId` check here (and the download
// route below).
import { NextResponse, type NextRequest } from "next/server";
import { ExportJobStore, getDriver } from "@sentinel-act/graph-db";
import { mapAuditQueryError } from "@/lib/console/audit-errors";
import { jsonError, mapSessionError } from "@/lib/console/route-errors";
import { getReviewerSession, OBSERVER_MODE_ROLES, requireRole, requireSession } from "@/lib/console/session";

// §8: "Export job stuck in running past a server restart ... a job left
// in running with no update for > 10 minutes is treated as failed by the
// NEXT poll ... which lazily flips stale running jobs to failed". 10
// minutes, matching the spec's literal number.
const STALE_RUNNING_MS = 10 * 60 * 1000;

export async function GET(request: NextRequest, context: { params: Promise<{ exportId: string }> }): Promise<NextResponse> {
  try {
    const session = requireSession(await getReviewerSession(request));
    requireRole(session, OBSERVER_MODE_ROLES);

    const { exportId } = await context.params;

    const store = new ExportJobStore(getDriver());
    const job = await store.find(exportId);
    if (!job) {
      return jsonError(404, "NOT_FOUND", `export job ${exportId} was not found.`);
    }

    if (job.status === "running") {
      const ageMs = Date.now() - new Date(job.requestedAt).getTime();
      if (ageMs > STALE_RUNNING_MS) {
        await store.markFailed(exportId, "generation did not complete, please retry");
        const refreshed = await store.find(exportId);
        return NextResponse.json(refreshed ?? job, { status: 200 });
      }
    }

    return NextResponse.json(job, { status: 200 });
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
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        operation: "GET /api/audit/export/:exportId",
        message: err instanceof Error ? err.message : String(err)
      })
    );
    return jsonError(500, "INTERNAL_ERROR");
  }
}
