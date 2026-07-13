// Spec 09 §12: BFF route-handler integration tests for
// `GET /api/console/queue` — previously untested (this file did not exist
// before this traceability pass; see lib/console/FR-TRACEABILITY.md for the
// full ledger of what this stage added vs. what remains genuinely
// untestable in this sandbox). Follows the same pattern as
// items/[obligationId]/route.test.ts: the exported `GET` handler is called
// directly with a constructed `NextRequest`, no running Next server, no
// live Neo4j/Orchestrator. `graph-queries.ts`'s `fetchQueueItems` and
// `orchestrator-client.ts`'s `getReviewGateBatch` are mocked.
//
// Covers: FR-1 (Tier A statuses never queried, default allow-list), FR-5
// (server-side risk-desc/sla-asc sort applied to the assembled response,
// not just unit-tested in isolation on sla.ts), FR-7 (assignedToMe
// visibility filter), FR-8 (compliance_head 403), and the §8
// Orchestrator-unavailable degraded-read row for this route.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { makeObligation, makeProcessTask } from "@/lib/console/test-fixtures";
import type { ObligationStatus, ReviewGateView } from "@/lib/console/types";

const { fetchQueueItemsMock } = vi.hoisted(() => ({ fetchQueueItemsMock: vi.fn() }));
vi.mock("@/lib/console/graph-queries", () => ({
  fetchQueueItems: fetchQueueItemsMock
}));

const { getReviewGateBatchMock } = vi.hoisted(() => ({ getReviewGateBatchMock: vi.fn() }));
vi.mock("@/lib/console/orchestrator-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/console/orchestrator-client")>("@/lib/console/orchestrator-client");
  return { ...actual, getReviewGateBatch: getReviewGateBatchMock };
});

import { GET } from "./route";
import { OrchestratorUnavailableError } from "@/lib/console/orchestrator-client";

function makeRequest(
  searchParams: Record<string, string> = {},
  headers: Record<string, string> = { "x-dev-reviewer-id": "reviewer-1", "x-dev-reviewer-role": "senior_compliance_officer" }
) {
  const url = new URL("http://localhost/api/console/queue");
  for (const [key, value] of Object.entries(searchParams)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url, { method: "GET", headers });
}

function makeQueueRow(obligationOverrides: Parameters<typeof makeObligation>[0] = {}, riskScore = 0.5) {
  return {
    obligation: makeObligation(obligationOverrides),
    processTask: makeProcessTask({ risk_score: riskScore }),
    clauseParaRef: "3.2",
    circularTitle: "SEBI Circular on Quarterly Reporting"
  };
}

beforeEach(() => {
  fetchQueueItemsMock.mockReset();
  getReviewGateBatchMock.mockReset();
  getReviewGateBatchMock.mockResolvedValue([]);
  fetchQueueItemsMock.mockResolvedValue([]);
});

describe("GET /api/console/queue — auth", () => {
  it("401s when no reviewer session can be resolved", async () => {
    const res = await GET(makeRequest({}, {}));
    expect(res.status).toBe(401);
  });

  // FR-8: compliance_head sessions MUST receive 403 from this endpoint —
  // Operator mode is not their surface (Spec 10's read-only endpoint is).
  it("403s for compliance_head (FR-8)", async () => {
    const res = await GET(makeRequest({}, { "x-dev-reviewer-id": "obs-1", "x-dev-reviewer-role": "compliance_head" }));
    expect(res.status).toBe(403);
    expect(fetchQueueItemsMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/console/queue — FR-1 (Tier A never appears / default statuses)", () => {
  it("defaults to statuses [tier_b_review, tier_c_review, escalated] when no statuses param is given", async () => {
    await GET(makeRequest());
    expect(fetchQueueItemsMock).toHaveBeenCalledWith(
      expect.objectContaining({ statuses: expect.arrayContaining(["tier_b_review", "tier_c_review", "escalated"]) })
    );
    const calledStatuses = fetchQueueItemsMock.mock.calls[0][0].statuses as string[];
    expect(calledStatuses).toHaveLength(3);
    expect(calledStatuses).not.toContain("tier_a_committed");
  });

  it("a requested status outside the Tier B/C/ESCALATE allow-list (e.g. tier_a_committed) is dropped, falling back to the default allow-list — Tier A is NEVER queried", async () => {
    await GET(makeRequest({ statuses: "tier_a_committed" }));
    const calledStatuses = fetchQueueItemsMock.mock.calls[0][0].statuses as string[];
    expect(calledStatuses).toEqual(["tier_b_review", "tier_c_review", "escalated"]);
  });

  it("a valid subset of statuses (e.g. tier_c_review only) is passed through as requested", async () => {
    await GET(makeRequest({ statuses: "tier_c_review" }));
    const calledStatuses = fetchQueueItemsMock.mock.calls[0][0].statuses as string[];
    expect(calledStatuses).toEqual(["tier_c_review"]);
  });
});

describe("GET /api/console/queue — FR-5 (server-side sort: riskScore DESC, slaDueAt ASC nulls-last)", () => {
  it("returns items pre-sorted by riskScore DESC — the response body itself, not just the underlying comparator in isolation", async () => {
    fetchQueueItemsMock.mockResolvedValue([
      makeQueueRow({ obligation_id: "low-risk", status: "tier_b_review" as ObligationStatus }, 0.2),
      makeQueueRow({ obligation_id: "high-risk", status: "tier_b_review" as ObligationStatus }, 0.9),
      makeQueueRow({ obligation_id: "mid-risk", status: "tier_b_review" as ObligationStatus }, 0.5)
    ]);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((i: { obligationId: string }) => i.obligationId)).toEqual(["high-risk", "mid-risk", "low-risk"]);
  });
});

describe("GET /api/console/queue — FR-7 (assignedToMe visibility filter)", () => {
  it("assignedToMe=true: an unclaimed Tier C item is visible (open slot, any eligible reviewer can claim it)", async () => {
    fetchQueueItemsMock.mockResolvedValue([makeQueueRow({ obligation_id: "obl-open", status: "tier_c_review" as ObligationStatus })]);
    getReviewGateBatchMock.mockResolvedValue([
      { obligationId: "obl-open", view: { kind: "tier_c", rationaleRequired: true, viewerSlot: null, status: "unclaimed", reveal: null } satisfies ReviewGateView }
    ]);

    const res = await GET(makeRequest({ assignedToMe: "true" }));
    const body = await res.json();
    expect(body.items.map((i: { obligationId: string }) => i.obligationId)).toEqual(["obl-open"]);
  });

  it("assignedToMe=true: a Tier C item the viewer has claimed (viewerSlot set) is visible", async () => {
    fetchQueueItemsMock.mockResolvedValue([makeQueueRow({ obligation_id: "obl-mine", status: "tier_c_review" as ObligationStatus })]);
    getReviewGateBatchMock.mockResolvedValue([
      {
        obligationId: "obl-mine",
        view: { kind: "tier_c", rationaleRequired: true, viewerSlot: "maker", status: "claimed_by_viewer", reveal: null } satisfies ReviewGateView
      }
    ]);

    const res = await GET(makeRequest({ assignedToMe: "true" }));
    const body = await res.json();
    expect(body.items.map((i: { obligationId: string }) => i.obligationId)).toEqual(["obl-mine"]);
  });

  it("assignedToMe=false: items are visible regardless of Tier C claim state", async () => {
    fetchQueueItemsMock.mockResolvedValue([makeQueueRow({ obligation_id: "obl-any", status: "tier_c_review" as ObligationStatus })]);
    getReviewGateBatchMock.mockResolvedValue([
      { obligationId: "obl-any", view: { kind: "tier_c", rationaleRequired: true, viewerSlot: null, status: "unclaimed", reveal: null } satisfies ReviewGateView }
    ]);

    const res = await GET(makeRequest({ assignedToMe: "false" }));
    const body = await res.json();
    expect(body.items.map((i: { obligationId: string }) => i.obligationId)).toEqual(["obl-any"]);
  });

  it("Tier B items are always visible under assignedToMe=true (no per-item assignment concept exists at Tier B — see queue/route.ts's gap-1 doc comment)", async () => {
    fetchQueueItemsMock.mockResolvedValue([makeQueueRow({ obligation_id: "obl-b", status: "tier_b_review" as ObligationStatus })]);
    const res = await GET(makeRequest({ assignedToMe: "true" }));
    const body = await res.json();
    expect(body.items.map((i: { obligationId: string }) => i.obligationId)).toEqual(["obl-b"]);
  });
});

describe("GET /api/console/queue — §8 degraded read (Orchestrator unavailable)", () => {
  it("still renders Neo4j-sourced items and flags orchestratorUnavailable: true, rather than throwing or hiding items", async () => {
    fetchQueueItemsMock.mockResolvedValue([makeQueueRow({ obligation_id: "obl-1", status: "tier_b_review" as ObligationStatus })]);
    getReviewGateBatchMock.mockRejectedValue(new OrchestratorUnavailableError("getReviewGateBatch", new Error("network down")));

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orchestratorUnavailable).toBe(true);
    expect(body.items).toHaveLength(1);
  });
});
