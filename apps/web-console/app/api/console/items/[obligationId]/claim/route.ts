// Spec 09 §5.1 `POST /api/console/items/:obligationId/claim` — Task 4.
// Thin proxy to the Orchestrator's claim endpoint, plus session
// verification (NFR-Security-2: `reviewerId` is ALWAYS taken from the
// server-verified session — this route does not read a request body at
// all, matching §5.1's documented `body: {}`).
import { NextResponse, type NextRequest } from "next/server";
import { getDriver } from "@sentinel-act/graph-db";
import { ObligationRepository } from "@/lib/console/graph-queries";
import { claimSlot, OrchestratorConfigError, OrchestratorResponseError, OrchestratorUnavailableError } from "@/lib/console/orchestrator-client";
import { jsonError, mapSessionError } from "@/lib/console/route-errors";
import { getReviewerSession, OPERATOR_MODE_ROLES, requireRole, requireSession } from "@/lib/console/session";
import { tierFromObligationStatus } from "@/lib/console/obligation-tier";

export async function POST(request: NextRequest, context: { params: Promise<{ obligationId: string }> }): Promise<NextResponse> {
  try {
    const session = requireSession(await getReviewerSession(request));
    requireRole(session, OPERATOR_MODE_ROLES); // FR-32/§8: compliance_head -> 403, checked before any Orchestrator call

    const { obligationId } = await context.params;

    const obligationRepo = new ObligationRepository(getDriver());
    const obligation = await obligationRepo.findById(obligationId);
    if (!obligation) {
      return jsonError(404, "NOT_FOUND", `obligation ${obligationId} was not found.`);
    }
    const tier = tierFromObligationStatus(obligation.status);
    if (tier !== "C") {
      // §5.1: "422 -> item is not Tier C (claiming is a Tier-C-only concept)".
      return jsonError(422, "NOT_TIER_C", "claiming is a Tier-C-only concept; this obligation is not awaiting Tier C review.");
    }

    let result;
    try {
      result = await claimSlot({ obligationId, reviewerId: session.reviewerId });
    } catch (err) {
      if (err instanceof OrchestratorUnavailableError || err instanceof OrchestratorConfigError) {
        return jsonError(502, "ORCHESTRATOR_UNAVAILABLE", "your claim was not recorded, please retry.");
      }
      if (err instanceof OrchestratorResponseError) {
        return jsonError(err.status, err.code, err.message);
      }
      throw err;
    }

    if (result.status === 409) {
      // http-server.ts's claim route does not distinguish "you already
      // hold a slot" from "both slots taken by others" — see that file's
      // own doc comment; SLOT_UNAVAILABLE covers both, a superset of
      // §5.1's documented ALREADY_CLAIMED_BY_SELF | NO_SLOTS_AVAILABLE.
      return jsonError(409, "SLOT_UNAVAILABLE");
    }

    // Immediately after a successful claim the viewer has not decided yet
    // — FR-21's "claimed_by_viewer" status, by definition, every time.
    return NextResponse.json({ viewerSlot: result.slot, status: "claimed_by_viewer" }, { status: 200 });
  } catch (err) {
    const sessionResponse = mapSessionError(err);
    if (sessionResponse) {
      return sessionResponse;
    }
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        operation: "POST /api/console/items/:obligationId/claim",
        message: err instanceof Error ? err.message : String(err)
      })
    );
    return jsonError(500, "INTERNAL_ERROR");
  }
}
