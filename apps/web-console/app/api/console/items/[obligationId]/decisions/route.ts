// Spec 09 §5.1 `POST /api/console/items/:obligationId/decisions` — Task 5.
//
// ***** `escalate_to_tier_c` — THE OPEN DESIGN QUESTION THIS ROUTE RESOLVES *****
//
// types.ts's `DecisionAction` doc comment left this as an explicit TODO for
// this stage: does the BFF call a distinct Orchestrator transition for
// `escalate_to_tier_c`, or does no such mechanism exist? Verified by
// reading apps/orchestrator/src/mastra/workflows/orchestrator.workflow.ts
// and orchestrator.logic.ts in full:
//
//   - `routeTier` (risk-score.scorer.ts) can return `tier: "ESCALATE"`
//     directly at initial routing time (a pre-review contradiction).
//   - `requiresSecondReview(tier)` returns `true` for BOTH `"C"` and
//     `"ESCALATE"` — meaning an ESCALATE item suspends at
//     `awaitHumanReviewStep` then `awaitSecondHumanReviewStep` from the
//     moment it's routed, using the EXACT SAME maker/checker suspend +
//     `SuspendedRunIndexPort.claim` mechanics as a Tier C item (`claim`
//     doesn't even look at tier). There is no separate "escalated but not
//     yet in a maker-checker flow" state to transition OUT of — an
//     ESCALATE item is *born* in that flow.
//   - `finalOutcomeFromReviewOutcome`'s only outputs are `"tier_a" |
//     "approve" | "reject" | "disagreement"` — there is no
//     `"promote_to_tier_c"`/"escalate" outcome, and `recordHumanReview`
//     (Spec 07) only ever accepts `ReviewDecision = "approve" | "reject"`
//     on the wire (`REVIEW_DECISIONS` in http-server.ts, and
//     graph-schema's `ReviewDecision` type itself has no third value).
//
// So `escalate_to_tier_c` has NO real orchestrator-side mechanism to call,
// and — per the analysis above — it is not merely unimplemented, it does
// not correspond to any reachable state in the real workflow graph (Spec
// 08 unified ESCALATE and Tier C's suspend mechanics from the moment of
// routing, something Spec 09 could not have known when it proposed this
// action, since Spec 08 did not exist yet). Per this task's brief, this is
// therefore a genuine, real gap: this route returns `501 NOT_IMPLEMENTED`
// with an explanatory body for `escalate_to_tier_c` on an ESCALATE item,
// rather than silently faking a transition or writing to the graph
// directly (which would violate the "Orchestrator is the only thing that
// commits to the graph" invariant). `escalate_to_tier_c` on a non-ESCALATE
// item is simply not a valid action (FR-28 only defines it for ESCALATE
// items) and gets `400 INVALID_DECISION`.
//
// A practical consequence worth stating plainly: since FR-27 also removes
// `"approve"` as a valid action for ESCALATE items, the only decision this
// route can ever actually submit to the Orchestrator for an ESCALATE item
// is `"reject"`. `HumanReview.tier` (graph-schema) has no `"ESCALATE"`
// value at all (`ReviewTier = "A" | "B" | "C"`, and http-server.ts's
// `REVIEW_TIERS` resume validator only accepts `"A" | "B" | "C"`) — this
// route sends `tier: "C"` on the wire for an ESCALATE item's reject
// (documented substitution below), since ESCALATE and Tier C share
// identical dual-review suspend/claim mechanics and "C" is the closest
// real `ReviewTier` value for a dual-independent-review decision.
//
// ***** Audit logging (FR-32) — verified, not duplicated *****
// `resumeOrchestratorRun` (orchestrator.workflow.ts) already calls
// `deps.monitoring.recordHumanReview(event.review)` (Spec 07's write path,
// itself the thing that appends to the Hash-chained Audit Ledger) AND
// `deps.auditLog({ kind: "human_review_submitted", ... })` internally,
// BEFORE `deps.engine.resume(...)`, and does so synchronously as part of
// the same `POST .../resume` call this route makes. There is nothing left
// for this BFF route to call separately — an extra audit-hook call here
// would double-log the same decision. (Verified by reading
// resumeOrchestratorRun's full body, not assumed.)
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getDriver } from "@sentinel-act/graph-db";
import { ObligationRepository } from "@/lib/console/graph-queries";
import {
  getReviewGate,
  getRunRef,
  submitDecision,
  OrchestratorConfigError,
  OrchestratorResponseError,
  OrchestratorUnavailableError
} from "@/lib/console/orchestrator-client";
import { jsonError, mapSessionError } from "@/lib/console/route-errors";
import { getReviewerSession, OPERATOR_MODE_ROLES, requireRole, requireSession } from "@/lib/console/session";
import { tierFromObligationStatus, type ReviewableTier } from "@/lib/console/obligation-tier";
import { isDecisionAllowedForTier, isRationaleRequired } from "@/lib/console/decision-rules";
import type { DecisionAction, HumanReview, ObligationStatus, ReviewGateView, SubmitDecisionResponse } from "@/lib/console/types";

const VALID_DECISIONS: ReadonlySet<DecisionAction> = new Set(["approve", "reject", "escalate_to_tier_c"]);

interface ParsedDecisionBody {
  decision: DecisionAction;
  rationale: string | null;
}

function parseBody(raw: unknown): ParsedDecisionBody | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const body = raw as Record<string, unknown>;
  const decision = body.decision;
  if (typeof decision !== "string" || !VALID_DECISIONS.has(decision as DecisionAction)) {
    return null;
  }
  const rationaleRaw = body.rationale;
  if (rationaleRaw !== null && rationaleRaw !== undefined && typeof rationaleRaw !== "string") {
    return null;
  }
  return { decision: decision as DecisionAction, rationale: typeof rationaleRaw === "string" ? rationaleRaw : null };
}

/** HumanReview.tier (graph-schema) has no "ESCALATE" value — see this
 *  file's top-of-file doc comment for why "C" is the substituted wire
 *  value for an ESCALATE item's reject. */
function humanReviewTierFor(tier: ReviewableTier): "B" | "C" {
  return tier === "B" ? "B" : "C";
}

export async function POST(request: NextRequest, context: { params: Promise<{ obligationId: string }> }): Promise<NextResponse> {
  try {
    const session = requireSession(await getReviewerSession(request));
    requireRole(session, OPERATOR_MODE_ROLES); // FR-32/§8: compliance_head -> 403, before any Orchestrator call

    const { obligationId } = await context.params;

    let body: ParsedDecisionBody | null;
    try {
      body = parseBody(await request.json());
    } catch {
      body = null;
    }
    if (!body) {
      return jsonError(400, "INVALID_DECISION", "request body must be { decision, rationale } with a valid decision value.");
    }
    const { decision, rationale } = body;

    const obligationRepo = new ObligationRepository(getDriver());
    const obligation = await obligationRepo.findById(obligationId);
    if (!obligation) {
      return jsonError(404, "NOT_FOUND", `obligation ${obligationId} was not found.`);
    }
    const tier = tierFromObligationStatus(obligation.status);
    if (!tier) {
      // Not currently awaiting review at all — §8's "Obligation's status
      // changes underneath an open detail view" row: the closest
      // documented code is 409 SUSPENDED_STEP_NOT_FOUND.
      return jsonError(409, "SUSPENDED_STEP_NOT_FOUND", "this item is no longer awaiting your review.");
    }

    // FR-27: approve is structurally disallowed on ESCALATE items. Backed by
    // decision-rules.ts's `isDecisionAllowedForTier` (the single
    // server-side source of truth for this rule — see that module's doc
    // comment) rather than an inline tier/decision check, so this rule is
    // unit-testable directly.
    if (decision === "approve" && !isDecisionAllowedForTier(tier, "approve")) {
      return jsonError(403, "ACTION_NOT_ALLOWED_FOR_TIER", '"approve" is not a valid action on an ESCALATE item.');
    }

    // escalate_to_tier_c — see top-of-file doc comment for the full analysis.
    if (decision === "escalate_to_tier_c") {
      if (tier !== "ESCALATE") {
        return jsonError(400, "INVALID_DECISION", '"escalate_to_tier_c" is only a valid action on an ESCALATE-tier item (FR-28).');
      }
      return jsonError(
        501,
        "NOT_IMPLEMENTED",
        '"escalate_to_tier_c" has no corresponding Orchestrator mechanism in the current implementation — ' +
          "ESCALATE items already run through the same dual-review suspend/claim flow as Tier C from the moment " +
          "they are routed (requiresSecondReview(\"ESCALATE\") === true), so there is no separate pre-Tier-C state " +
          "to transition out of, and recordHumanReview only accepts decision \"approve\"|\"reject\" on the wire. " +
          "Use \"reject\" to resolve this item through the existing dual-review flow instead."
      );
    }

    // From here, decision is "approve" | "reject" (escalate_to_tier_c and
    // the ESCALATE+approve case are both handled above).
    const humanReviewDecision = decision as "approve" | "reject";

    // FR-25: rationale required at Tier C / ESCALATE (encoded directly by
    // TierCReviewGateView/EscalateReviewGateView's literal
    // `rationaleRequired: true` — Tier B alone is `false`, FR-17). Backed by
    // decision-rules.ts's `isRationaleRequired` so this is unit-testable
    // directly, not just reachable by exercising the whole route.
    const rationaleRequired = isRationaleRequired(tier);
    const trimmedRationale = rationale?.trim() ?? "";
    if (rationaleRequired && trimmedRationale.length === 0) {
      return jsonError(400, "RATIONALE_REQUIRED", "rationale is required (non-empty) for Tier C and ESCALATE decisions.");
    }

    let runRef;
    try {
      runRef = await getRunRef(obligationId);
    } catch (err) {
      const mapped = mapOrchestratorTransportError(err);
      if (mapped) return mapped;
      throw err;
    }
    if (!runRef) {
      return jsonError(409, "SUSPENDED_STEP_NOT_FOUND", "no suspended run is recorded for this obligation.");
    }

    const decidedAt = new Date().toISOString();
    const review = {
      event_id: randomUUID(),
      obligation_id: obligationId,
      reviewer_id: session.reviewerId,
      tier: humanReviewTierFor(tier),
      decision: humanReviewDecision,
      rationale: rationaleRequired ? trimmedRationale : trimmedRationale.length > 0 ? trimmedRationale : null,
      decided_at: decidedAt,
      source: "web-console" as const,
      source_ref: null
    };

    let resumeResult;
    try {
      resumeResult = await submitDecision({ runId: runRef.runId, stepId: runRef.stepId, obligation_id: obligationId, review });
    } catch (err) {
      const mapped = mapOrchestratorTransportError(err);
      if (mapped) return mapped;
      throw err;
    }

    if (!resumeResult.resumed) {
      // FR-30/§8 duplicate-event row: the step was no longer the
      // suspended step by the time this call reached the Orchestrator —
      // either this reviewer's own resubmission, or a stale run.
      return jsonError(409, "ALREADY_DECIDED", "a decision has already been recorded for this run step.");
    }

    // Best-effort re-fetch of the updated gate (same redaction rules as
    // GET detail — §5.1's documented response shape). NOT a fallback for
    // the resume call itself; if this fails, the decision was still
    // recorded (resumed === true above), we just can't show the freshest
    // gate state in this response.
    let updatedGate: ReviewGateView | null = null;
    try {
      updatedGate = await getReviewGate({ obligationId, reviewerId: session.reviewerId, tier });
    } catch {
      updatedGate = null;
    }

    // GAP: the Orchestrator's real `POST .../resume` response is
    // `{ resumed, finalStatus }` only (http-server.ts's handleResume) —
    // NOT Spec 09 §5.2's originally-proposed
    // `{ obligationStatus, humanReview, workflowState, reviewGate }`. In
    // particular it does NOT return the written `HumanReview` record
    // (Spec 07's `recordHumanReview` assigns its own `review_id`/
    // `recorded_at` server-side, neither of which is echoed back). This
    // response's `humanReview` is therefore a BEST-EFFORT reconstruction
    // from exactly what this route just sent — `reviewer_id`/`tier`/
    // `decision`/`rationale`/`decided_at`/`obligation_id` are accurate
    // (they're verbatim what was written), but `review_id` reuses this
    // request's own `event_id` (not the server-assigned review_id, which
    // this BFF has no way to learn) and the bitemporal fields
    // (`valid_from`/`valid_to`/`recorded_at`) are approximated from
    // `decided_at` rather than the ledger's real values. Flagged here,
    // not silently presented as authoritative — a later stage should
    // thread the real `HumanReview` back through `resumeOrchestratorRun`'s
    // return value and the HTTP resume response to close this gap.
    const humanReview: HumanReview = {
      review_id: review.event_id,
      obligation_id: review.obligation_id,
      reviewer_id: review.reviewer_id,
      tier: review.tier,
      decision: review.decision,
      rationale: review.rationale,
      decided_at: review.decided_at,
      valid_from: review.decided_at.slice(0, 10),
      valid_to: null,
      recorded_at: review.decided_at
    };

    const obligationStatus: ObligationStatus =
      resumeResult.finalStatus === "still_pending" ? obligation.status : (resumeResult.finalStatus as ObligationStatus);

    const response: SubmitDecisionResponse = {
      obligationStatus,
      humanReview,
      reviewGate: updatedGate ?? unavailableReviewGate(tier)
    };
    return NextResponse.json(response, { status: 200 });
  } catch (err) {
    const sessionResponse = mapSessionError(err);
    if (sessionResponse) {
      return sessionResponse;
    }
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        operation: "POST /api/console/items/:obligationId/decisions",
        message: err instanceof Error ? err.message : String(err)
      })
    );
    return jsonError(500, "INTERNAL_ERROR");
  }
}

/** §8: "Orchestrator unavailable during POST .../decisions" -> 502 with a
 *  retry-safe message; a well-formed non-2xx Orchestrator response is
 *  passed through with its real status/code (e.g. 409
 *  SUSPENDED_STEP_NOT_FOUND, 403 SELF_REVIEW_FORBIDDEN). Returns `null`
 *  for anything else so the caller's own catch/throw takes over. */
function mapOrchestratorTransportError(err: unknown): NextResponse | null {
  if (err instanceof OrchestratorUnavailableError || err instanceof OrchestratorConfigError) {
    return jsonError(502, "ORCHESTRATOR_UNAVAILABLE", "your decision was not recorded, please retry.");
  }
  if (err instanceof OrchestratorResponseError) {
    return jsonError(err.status, err.code, err.message);
  }
  return null;
}

function unavailableReviewGate(tier: ReviewableTier): ReviewGateView {
  if (tier === "B") {
    return { kind: "tier_b", rationaleRequired: false, existingDecision: null };
  }
  if (tier === "ESCALATE") {
    return { kind: "escalate", rationaleRequired: true, existingDecision: null };
  }
  return { kind: "tier_c", rationaleRequired: true, viewerSlot: null, status: "unclaimed", reveal: null };
}
