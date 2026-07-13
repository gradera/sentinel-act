// Spec 10 §5.3 `GET /api/audit/reviews/:reviewId` — FR-10's deep-link
// target ("the deep-link target used by any external surface (Slack, the
// Conversational Assistant) that cites a specific decision"). Read-only:
// the only graph call is `AuditQueryService.findByReviewId` (FR-21).
import { NextResponse, type NextRequest } from "next/server";
import { AuditQueryService, getDriver } from "@sentinel-act/graph-db";
import { mapAuditQueryError } from "@/lib/console/audit-errors";
import { jsonError, mapSessionError } from "@/lib/console/route-errors";
import { getReviewerSession, OBSERVER_MODE_ROLES, requireRole, requireSession } from "@/lib/console/session";

export async function GET(request: NextRequest, context: { params: Promise<{ reviewId: string }> }): Promise<NextResponse> {
  try {
    const session = requireSession(await getReviewerSession(request));
    requireRole(session, OBSERVER_MODE_ROLES);

    const { reviewId } = await context.params;

    const service = new AuditQueryService(getDriver());
    const row = await service.findByReviewId(reviewId);
    if (!row) {
      // FR-10: "MUST return 404 (not an empty 200) for an unknown
      // review_id" — this also correctly covers an FR-11a-suppressed
      // in-progress Tier C/ESCALATE maker decision (AuditQueryService's own
      // doc comment: "an auditor cannot distinguish 'does not exist' from
      // 'exists but is not yet visible to you', which is the correct
      // behavior for this surface").
      return jsonError(404, "NOT_FOUND", `HumanReview ${reviewId} was not found.`);
    }

    return NextResponse.json(row, { status: 200 });
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
        operation: "GET /api/audit/reviews/:reviewId",
        message: err instanceof Error ? err.message : String(err)
      })
    );
    return jsonError(500, "INTERNAL_ERROR");
  }
}
