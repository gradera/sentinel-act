// Spec 09 §5.1 `GET /api/console/queue` — Task 2.
//
// KNOWN GAPS this handler documents rather than fakes (both are real data-
// model gaps in the shipped apps/orchestrator, not bugs in this file):
//
//   1. No `assignedReviewerId` concept exists for Tier B in the real
//      workflow (`awaitHumanReviewStep` suspends for ANY eligible
//      reviewer — there is no per-item assignment/claim step at Tier B,
//      unlike Tier C's `SuspendedRunIndexPort.claim`). So `assignedReviewerId`
//      is always `null` here, and FR-7's "assignedToMe" filter — literally
//      "reviewerId === assignedReviewerId OR (Tier C and unclaimed)" —
//      would degenerate to "only unclaimed Tier C items" if applied
//      literally, hiding every Tier B item and every Tier C item the
//      viewer has already claimed. `isVisibleForAssignedToMe` below
//      documents the pragmatic reading used instead: Tier B/ESCALATE
//      items are always visible (no real assignment data to filter on);
//      Tier C items are visible when unclaimed OR claimed BY the viewer.
//   2. The Orchestrator's wire `ReviewGateView` (types.ts) carries no
//      timing field — `suspendedAt` lives only in `awaitHumanReviewSuspendStateSchema`
//      internal to the suspended Mastra run, never surfaced over HTTP by
//      any route built so far. `slaDueAt` is therefore always `null` and
//      `slaState` always `"ok"` until a later stage adds that to the
//      review-gate/run-ref wire shape — flagged here, not silently guessed.
import { NextResponse, type NextRequest } from "next/server";
import { fetchQueueItems } from "@/lib/console/graph-queries";
import {
  getReviewGateBatch,
  OrchestratorConfigError,
  OrchestratorResponseError,
  OrchestratorUnavailableError
} from "@/lib/console/orchestrator-client";
import { jsonError, mapSessionError } from "@/lib/console/route-errors";
import { compareQueueItems, computeSlaState } from "@/lib/console/sla";
import { getReviewerSession, OPERATOR_MODE_ROLES, requireRole, requireSession } from "@/lib/console/session";
import { truncateRequirementText } from "@/lib/console/summary";
import { tierFromObligationStatus } from "@/lib/console/obligation-tier";
import type {
  ObligationStatus,
  QueueItemSummary,
  QueueListResponse,
  ReviewGateView,
  TierCViewerQueueState
} from "@/lib/console/types";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

// FR-1: Tier A MUST NEVER appear in this endpoint's response. This is the
// exhaustive allow-list of statuses this route will ever query for —
// enforced by intersection below regardless of what a caller requests.
const ALLOWED_STATUSES: ObligationStatus[] = ["tier_b_review", "tier_c_review", "escalated"];
const ALL_TIERS: Array<"B" | "C" | "ESCALATE"> = ["B", "C", "ESCALATE"];

function parseTiers(raw: string | null): Array<"B" | "C" | "ESCALATE"> {
  if (!raw) {
    return ALL_TIERS;
  }
  const requested = raw
    .split(",")
    .map((t) => t.trim())
    .filter((t): t is "B" | "C" | "ESCALATE" => t === "B" || t === "C" || t === "ESCALATE");
  return requested.length > 0 ? requested : ALL_TIERS;
}

function parseStatuses(raw: string | null): ObligationStatus[] {
  if (!raw) {
    return ALLOWED_STATUSES;
  }
  const requested = raw.split(",").map((s) => s.trim());
  const filtered = requested.filter((s): s is ObligationStatus => (ALLOWED_STATUSES as string[]).includes(s));
  return filtered.length > 0 ? filtered : ALLOWED_STATUSES;
}

function parseLimit(raw: string | null): number {
  const n = raw ? Number.parseInt(raw, 10) : DEFAULT_LIMIT;
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(n, MAX_LIMIT);
}

function tierCStateFromView(view: ReviewGateView | undefined): TierCViewerQueueState | null {
  if (!view || view.kind !== "tier_c") {
    return null;
  }
  return { viewerSlot: view.viewerSlot, status: view.status };
}

/** See this file's top-of-file doc comment, gap (1). */
function isVisibleForAssignedToMe(tier: "B" | "C" | "ESCALATE", tierCState: TierCViewerQueueState | null): boolean {
  if (tier !== "C") {
    return true;
  }
  if (!tierCState) {
    // Degraded read (Orchestrator unavailable) — do not hide the item;
    // §8 says the page still renders, it just can't refine "assigned to
    // me" without the gate data.
    return true;
  }
  return tierCState.viewerSlot !== null || tierCState.status === "unclaimed";
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const session = requireSession(await getReviewerSession(request));
    requireRole(session, OPERATOR_MODE_ROLES); // FR-8: compliance_head -> 403

    const url = request.nextUrl;
    const tiers = parseTiers(url.searchParams.get("tiers"));
    const requestedStatuses = parseStatuses(url.searchParams.get("statuses"));
    const tierFilteredStatuses = requestedStatuses.filter((s) => {
      const tier = tierFromObligationStatus(s);
      return tier !== null && tiers.includes(tier);
    });
    const statuses = tierFilteredStatuses.length > 0 ? tierFilteredStatuses : requestedStatuses;

    const limit = parseLimit(url.searchParams.get("limit"));
    const cursorParam = url.searchParams.get("cursor");
    const skip = cursorParam ? Number.parseInt(cursorParam, 10) || 0 : 0;

    const assignedToMeParam = url.searchParams.get("assignedToMe");
    const assignedToMe =
      assignedToMeParam !== null
        ? assignedToMeParam === "true"
        : session.role === "compliance_officer" || session.role === "senior_compliance_officer";

    // Fetch limit+1 rows so nextCursor can be derived without a second count query.
    const rows = await fetchQueueItems({ statuses, skip, limit: limit + 1 });
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    let batchByObligationId = new Map<string, ReviewGateView>();
    let orchestratorUnavailable = false;
    try {
      const batchItems = pageRows
        .map((row) => {
          const tier = tierFromObligationStatus(row.obligation.status);
          return tier ? { obligationId: row.obligation.obligation_id, tier } : null;
        })
        .filter((item): item is { obligationId: string; tier: "B" | "C" | "ESCALATE" } => item !== null);
      const results = await getReviewGateBatch({ reviewerId: session.reviewerId, items: batchItems });
      batchByObligationId = new Map(results.map((r) => [r.obligationId, r.view]));
    } catch (err) {
      if (err instanceof OrchestratorUnavailableError || err instanceof OrchestratorResponseError || err instanceof OrchestratorConfigError) {
        // §8: "Queue/detail still render using Neo4j-sourced content;
        // reviewGate/slaDueAt/tierCViewerState degrade to a clearly-marked
        // status unavailable placeholder" — not thrown, not a blank field.
        orchestratorUnavailable = true;
      } else {
        throw err;
      }
    }

    const items: QueueItemSummary[] = [];
    for (const row of pageRows) {
      const tier = tierFromObligationStatus(row.obligation.status) ?? "B"; // unreachable fallback, statuses are pre-filtered to the allow-list
      const view = batchByObligationId.get(row.obligation.obligation_id);
      const tierCViewerState = tier === "C" ? tierCStateFromView(view) : null;

      // Gap (2): slaDueAt is not on the wire yet — see top-of-file comment.
      const slaDueAt: string | null = null;
      const slaState = computeSlaState(slaDueAt);

      if (assignedToMe && !isVisibleForAssignedToMe(tier, tierCViewerState)) {
        continue;
      }

      items.push({
        obligationId: row.obligation.obligation_id,
        circularTitle: row.circularTitle ?? "",
        category: row.obligation.category,
        summary: truncateRequirementText(row.obligation.requirement_text),
        tier,
        tierReasons: [], // best-effort from Spec 07's ledger — not wired in this stage, never blocks render
        confidenceScore: row.obligation.confidence_score,
        groundingScore: row.obligation.grounding_score,
        riskScore: row.processTask.risk_score,
        status: row.obligation.status,
        slaDueAt,
        slaState,
        isEscalated: row.obligation.status === "escalated",
        escalationReason: null, // no SLA-breach-reassignment data source wired in this stage (see graph-queries.ts scope)
        assignedReviewerId: null, // gap (1) — see top-of-file comment
        tierCViewerState
      });
    }

    items.sort((a, b) => compareQueueItems({ riskScore: a.riskScore, slaDueAt: a.slaDueAt }, { riskScore: b.riskScore, slaDueAt: b.slaDueAt }));

    const response: QueueListResponse = {
      items,
      nextCursor: hasMore ? String(skip + limit) : null,
      orchestratorUnavailable
    };
    return NextResponse.json(response, { status: 200 });
  } catch (err) {
    const sessionResponse = mapSessionError(err);
    if (sessionResponse) {
      return sessionResponse;
    }
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", operation: "GET /api/console/queue", message: err instanceof Error ? err.message : String(err) }));
    return jsonError(500, "INTERNAL_ERROR");
  }
}
