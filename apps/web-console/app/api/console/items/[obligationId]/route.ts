// Spec 09 §5.1 `GET /api/console/items/:obligationId` — Task 3.
//
// This route handler IS the security boundary for the Tier C independence
// guarantee (§3/FR-26: "the browser's network response is the actual
// security boundary... regardless of what the client-side React code does
// or doesn't render") — `reviewGate` is fetched and merged here, server
// side, and nothing upstream of this function's return value is allowed to
// see an unredacted peer decision.
//
// KNOWN GAPS documented rather than faked (consistent with this app's
// established pattern elsewhere — see orchestrator-client.ts/types.ts):
//   - `contradiction` is always `null`, even for `tier === "ESCALATE"`
//     (deviates from FR-15's letter). Spec 04's grounding-verification
//     critic output (the real `ContradictionDetail` source) is never
//     persisted as a queryable graph node/edge anywhere in
//     @sentinel-act/graph-schema — it exists only transiently during a
//     pipeline run, to decide `hasContradiction`/tier routing, and is
//     never written back for later retrieval. There is nothing this BFF
//     can read to reconstruct it. Flagged, not silently invented.
//   - `slaDueAt`/`slaState` — see queue/route.ts's gap (2): the
//     Orchestrator's wire `ReviewGateView` carries no timing field yet.
//   - `escalationReason` (SLA-breach reassignment banner, FR-29) has no
//     data source wired in this stage — same gap as the queue route.
//   - Lineage omits the `EvidenceArtifact` step (FR-14's full chain) —
//     `graph-queries.ts`'s `OBLIGATION_DETAIL_CYPHER` does not fetch it;
//     out of scope for this stage's BFF-plumbing task to extend.
import { NextResponse, type NextRequest } from "next/server";
import { fetchObligationDetail } from "@/lib/console/graph-queries";
import { getReviewGate, OrchestratorConfigError, OrchestratorResponseError, OrchestratorUnavailableError } from "@/lib/console/orchestrator-client";
import { jsonError, mapSessionError } from "@/lib/console/route-errors";
import { computeSlaState } from "@/lib/console/sla";
import { getReviewerSession, OPERATOR_MODE_ROLES, requireRole, requireSession } from "@/lib/console/session";
import { tierFromObligationStatus } from "@/lib/console/obligation-tier";
import type {
  FieldDiffStatus,
  ObligationDetailResponse,
  ProcessTask,
  ProcessTaskDiff,
  ProcessTaskDraft,
  ProcessTaskFieldDiff,
  ReviewGateView
} from "@/lib/console/types";

const PROCESS_TASK_DIFF_FIELDS: Array<ProcessTaskFieldDiff["field"]> = [
  "task_name",
  "owner_role",
  "sla_hours",
  "system_touchpoint",
  "risk_score"
];

function buildProcessTaskFieldDiffs(prior: ProcessTask | null, current: ProcessTask): ProcessTaskFieldDiff[] {
  return PROCESS_TASK_DIFF_FIELDS.map((field) => {
    const newValue = current[field] as string | number;
    if (!prior) {
      return { field, oldValue: null, newValue, status: "added" as FieldDiffStatus };
    }
    const oldValue = prior[field] as string | number;
    const status: FieldDiffStatus = oldValue === newValue ? "unchanged" : "changed";
    return { field, oldValue, newValue, status };
  });
}

function buildProcessTaskDraft(task: ProcessTask): ProcessTaskDraft {
  // Rest-destructure to drop the 4 fields ProcessTaskDraft omits; the
  // left-hand bindings are intentionally unused (that's the whole point of
  // the destructure), so this line is exempted from no-unused-vars rather
  // than fighting the rule with unused underscore-prefixed bindings.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { task_id, valid_from, valid_to, recorded_at, ...draft } = task;
  return draft;
}

/** §8's degraded-read row: a maximally-restrictive placeholder — never
 *  claims a decision exists, never claims resolution — used only when the
 *  Orchestrator's review-gate call itself failed. */
function unavailableReviewGate(tier: "B" | "C" | "ESCALATE"): ReviewGateView {
  if (tier === "B") {
    return { kind: "tier_b", rationaleRequired: false, existingDecision: null };
  }
  if (tier === "ESCALATE") {
    return { kind: "escalate", rationaleRequired: true, existingDecision: null };
  }
  return { kind: "tier_c", rationaleRequired: true, viewerSlot: null, status: "unclaimed", reveal: null };
}

export async function GET(request: NextRequest, context: { params: Promise<{ obligationId: string }> }): Promise<NextResponse> {
  try {
    const session = requireSession(await getReviewerSession(request));
    requireRole(session, OPERATOR_MODE_ROLES); // FR-8 / §5.1: "401/403 (same as above)" — compliance_head excluded here too

    const { obligationId } = await context.params;
    const detail = await fetchObligationDetail(obligationId);
    if (!detail) {
      return jsonError(404, "NOT_FOUND", `obligation ${obligationId} was not found.`);
    }

    const tier = tierFromObligationStatus(detail.obligation.status);
    if (!tier) {
      // Not in a reviewable status (proposed / tier_a_committed / committed
      // / rejected) — §5.1: "404 -> obligation not found or not in a
      // reviewable status".
      return jsonError(404, "NOT_FOUND", `obligation ${obligationId} is not in a reviewable status (status=${detail.obligation.status}).`);
    }

    const processTaskDiff: ProcessTaskDiff | null = detail.processTask
      ? {
          obligationId: detail.obligation.obligation_id,
          redline: {
            oldTaskId: detail.priorProcessTask?.task_id ?? null,
            oldObligationId: detail.priorObligation?.obligation_id ?? null,
            newProcessTaskDraft: buildProcessTaskDraft(detail.processTask),
            newObligationProposal: {},
            fields: buildProcessTaskFieldDiffs(detail.priorProcessTask, detail.processTask),
            overallStatus: detail.priorProcessTask ? "modified" : "new"
          }
        }
      : null;

    const lineage: ObligationDetailResponse["lineage"] = [
      { label: detail.circular.title },
      { label: `Clause ${detail.clause.para_ref}` },
      { label: `Obligation ${detail.obligation.obligation_id}`, href: `/queue/${detail.obligation.obligation_id}` },
      ...(detail.processTask ? [{ label: `ProcessTask ${detail.processTask.task_id}` }] : [])
    ];

    let reviewGate: ReviewGateView;
    let reviewGateUnavailable = false;
    try {
      reviewGate = await getReviewGate({ obligationId, reviewerId: session.reviewerId, tier });
    } catch (err) {
      if (err instanceof OrchestratorUnavailableError || err instanceof OrchestratorResponseError || err instanceof OrchestratorConfigError) {
        reviewGate = unavailableReviewGate(tier);
        reviewGateUnavailable = true;
      } else {
        throw err;
      }
    }

    // Gap: no timing field on the wire yet (see top-of-file comment).
    const slaDueAt: string | null = null;
    const slaState = computeSlaState(slaDueAt);

    const response: ObligationDetailResponse = {
      obligation: detail.obligation,
      sourceClause: { clauseId: detail.clause.clause_id, paraRef: detail.clause.para_ref, text: detail.clause.text },
      sourceCircular: {
        circularId: detail.circular.circular_id,
        title: detail.circular.title,
        dateEffective: detail.circular.date_effective
      },
      processTaskDiff,
      lineage,
      contradiction: null, // gap — see top-of-file comment
      tier,
      tierReasons: [], // best-effort from Spec 07's ledger — not wired in this stage
      reviewGate,
      slaDueAt,
      slaState,
      escalationReason: null, // gap — see top-of-file comment
      reviewGateUnavailable
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
        operation: "GET /api/console/items/:obligationId",
        message: err instanceof Error ? err.message : String(err)
      })
    );
    return jsonError(500, "INTERNAL_ERROR");
  }
}
