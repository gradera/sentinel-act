// Spec 09 §12's hard-blocker integration test: "an automated integration
// test ... that reads the raw JSON response body, not the DOM, and asserts
// the peer's decision fields are absent until reviewGate.status starts with
// resolved_." This is the NFR-Security-1 / Tier C independence-guarantee
// test for `GET /api/console/items/:obligationId` — the route Spec 09 §3
// calls "the security boundary" itself.
//
// The route handler is called DIRECTLY (a plain exported async function,
// per Next.js App Router's own contract) with a constructed `NextRequest` —
// no running `next dev`/`next start` process, no live Neo4j/orchestrator.
// `graph-queries.ts`'s `fetchObligationDetail` and `orchestrator-client.ts`'s
// `getReviewGate` are mocked; everything else (session resolution via the
// dev-header bridge, tier derivation, response assembly) runs for real.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  containsHumanReviewFields,
  findHumanReviewShapedObjects,
  makeCircular,
  makeClause,
  makeHumanReview,
  makeObligation,
  makeProcessTask
} from "@/lib/console/test-fixtures";
import type { ObligationStatus, TierCReviewGateView } from "@/lib/console/types";

const { fetchObligationDetailMock } = vi.hoisted(() => ({ fetchObligationDetailMock: vi.fn() }));
vi.mock("@/lib/console/graph-queries", () => ({
  fetchObligationDetail: fetchObligationDetailMock
}));

const { getReviewGateMock } = vi.hoisted(() => ({ getReviewGateMock: vi.fn() }));
vi.mock("@/lib/console/orchestrator-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/console/orchestrator-client")>("@/lib/console/orchestrator-client");
  return { ...actual, getReviewGate: getReviewGateMock };
});

import { GET } from "./route";
import { OrchestratorUnavailableError } from "@/lib/console/orchestrator-client";

function makeRequest(headers: Record<string, string> = { "x-dev-reviewer-id": "checker-1", "x-dev-reviewer-role": "senior_compliance_officer" }) {
  return new NextRequest("http://localhost/api/console/items/obligation-1", { method: "GET", headers });
}

function callRoute(req: NextRequest, obligationId = "obligation-1") {
  return GET(req, { params: Promise.resolve({ obligationId }) });
}

function makeDetailRow(status: ObligationStatus) {
  return {
    obligation: makeObligation({ status }),
    clause: makeClause(),
    circular: makeCircular(),
    processTask: makeProcessTask(),
    priorObligation: null,
    priorProcessTask: null
  };
}

beforeEach(() => {
  fetchObligationDetailMock.mockReset();
  getReviewGateMock.mockReset();
});

// FR-18/FR-26: this whole describe block IS the test that the BFF merges
// whatever per-caller-redacted ReviewGateView the Orchestrator's
// `getReviewGate` mock returns server-side (route.ts, never client JS) into
// the response body, without ever adding, dropping, or re-deriving any
// peer-decision field itself — i.e. the BFF is a faithful, non-leaking
// pass-through of whatever per-reviewerId view it was given (FR-18's "per
// the calling reviewerId, never a shared/cached object" is the
// Orchestrator's own responsibility, simulated here by each test supplying
// a different mock view; FR-26 is specifically that this merge happens in
// this route handler, not client-side — true by construction, since this
// test calls the route handler directly and inspects its raw return body).
// FR-19 is the "unclaimed | claimed_by_viewer, no hint of the peer" case;
// FR-22 is "viewer_submitted_awaiting_peer, reveal stays null"; FR-23 is
// "resolved_agree | resolved_disagree, both reviews revealed". AC-2 and
// AC-3 map onto the same scenarios (see each test's own tag below).
describe("GET /api/console/items/:obligationId — Tier C independence guarantee (NFR-Security-1)", () => {
  // FR-22, AC-2 (first half: reviewer B has not yet claimed a slot, gate is
  // pre-resolution and shows no trace of reviewer A's decision).
  it("leaks NO HumanReview-shaped object anywhere in the response body while awaiting the peer's decision", async () => {
    fetchObligationDetailMock.mockResolvedValue(makeDetailRow("tier_c_review"));
    const gate: TierCReviewGateView = {
      kind: "tier_c",
      rationaleRequired: true,
      viewerSlot: "maker",
      status: "viewer_submitted_awaiting_peer",
      reveal: null
    };
    getReviewGateMock.mockResolvedValue(gate);

    const res = await callRoute(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();

    // Sanity: the gate really is present and really is the pre-resolution
    // shape this test claims to be exercising.
    expect(body.reviewGate.status).toBe("viewer_submitted_awaiting_peer");
    expect(body.reviewGate.reveal).toBeNull();

    // THE assertion: walk the ENTIRE response tree, not just
    // `reviewGate.reveal` — a naive top-level check would miss a leak
    // anywhere else in the payload.
    const leaked = findHumanReviewShapedObjects(body);
    expect(leaked).toEqual([]);
    expect(containsHumanReviewFields(body)).toBe(false);
  });

  // FR-19: viewer who hasn't claimed (or has claimed but not decided) gets
  // viewerSlot/status only, never a hint about the peer.
  it("leaks NO HumanReview-shaped object while the gate is merely unclaimed or claimed_by_viewer either", async () => {
    fetchObligationDetailMock.mockResolvedValue(makeDetailRow("tier_c_review"));
    for (const status of ["unclaimed", "claimed_by_viewer"] as const) {
      getReviewGateMock.mockResolvedValue({
        kind: "tier_c",
        rationaleRequired: true,
        viewerSlot: status === "claimed_by_viewer" ? "maker" : null,
        status,
        reveal: null
      } satisfies TierCReviewGateView);

      const res = await callRoute(makeRequest());
      const body = await res.json();
      expect(containsHumanReviewFields(body)).toBe(false);
    }
  });

  // FR-23: both slots submitted, same decision -> resolved_agree, both full
  // HumanReview records revealed.
  it("reveals BOTH HumanReview records once status starts with resolved_ (resolved_agree)", async () => {
    fetchObligationDetailMock.mockResolvedValue(makeDetailRow("tier_c_review"));
    const makerReview = makeHumanReview({ review_id: "review-maker", reviewer_id: "maker-1", decision: "approve" });
    const checkerReview = makeHumanReview({ review_id: "review-checker", reviewer_id: "checker-1", decision: "approve" });
    const gate: TierCReviewGateView = {
      kind: "tier_c",
      rationaleRequired: true,
      viewerSlot: "checker",
      status: "resolved_agree",
      reveal: { reviews: [makerReview, checkerReview], agreement: true }
    };
    getReviewGateMock.mockResolvedValue(gate);

    const res = await callRoute(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.reviewGate.status).toBe("resolved_agree");
    const leaked = findHumanReviewShapedObjects(body);
    expect(leaked).toHaveLength(2);
    const reviewerIds = leaked.map((r) => r.reviewer_id).sort();
    expect(reviewerIds).toEqual(["checker-1", "maker-1"]);
  });

  // FR-23, AC-3 (reveal half only — see FR-TRACEABILITY.md for why AC-3's
  // workflowState/Obligation.status assertions aren't testable here).
  it("reveals BOTH HumanReview records for resolved_disagree too", async () => {
    fetchObligationDetailMock.mockResolvedValue(makeDetailRow("tier_c_review"));
    const makerReview = makeHumanReview({ review_id: "review-maker", reviewer_id: "maker-1", decision: "approve" });
    const checkerReview = makeHumanReview({ review_id: "review-checker", reviewer_id: "checker-1", decision: "reject" });
    getReviewGateMock.mockResolvedValue({
      kind: "tier_c",
      rationaleRequired: true,
      viewerSlot: "checker",
      status: "resolved_disagree",
      reveal: { reviews: [makerReview, checkerReview], agreement: false }
    } satisfies TierCReviewGateView);

    const res = await callRoute(makeRequest());
    const body = await res.json();
    expect(findHumanReviewShapedObjects(body)).toHaveLength(2);
  });

  it("degraded-read placeholder (Orchestrator unavailable) also leaks nothing and flags reviewGateUnavailable", async () => {
    fetchObligationDetailMock.mockResolvedValue(makeDetailRow("tier_c_review"));
    getReviewGateMock.mockRejectedValue(new OrchestratorUnavailableError("getReviewGate", new Error("network down")));

    const res = await callRoute(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reviewGateUnavailable).toBe(true);
    expect(body.reviewGate.reveal).toBeNull();
    expect(containsHumanReviewFields(body)).toBe(false);
  });
});

describe("GET /api/console/items/:obligationId — other behaviors", () => {
  it("401s when no reviewer session can be resolved", async () => {
    fetchObligationDetailMock.mockResolvedValue(makeDetailRow("tier_b_review"));
    const res = await callRoute(makeRequest({}));
    expect(res.status).toBe(401);
  });

  it("403s for compliance_head (Observer mode, FR-8)", async () => {
    fetchObligationDetailMock.mockResolvedValue(makeDetailRow("tier_b_review"));
    const res = await callRoute(makeRequest({ "x-dev-reviewer-id": "obs-1", "x-dev-reviewer-role": "compliance_head" }));
    expect(res.status).toBe(403);
  });

  it("404s when the obligation does not exist", async () => {
    fetchObligationDetailMock.mockResolvedValue(null);
    const res = await callRoute(makeRequest());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("NOT_FOUND");
  });

  it("404s when the obligation exists but is not in a reviewable status", async () => {
    fetchObligationDetailMock.mockResolvedValue(makeDetailRow("committed"));
    const res = await callRoute(makeRequest());
    expect(res.status).toBe(404);
  });

  it("Tier B: existingDecision (my own decision only) passes through unredacted for the viewer's own decision", async () => {
    fetchObligationDetailMock.mockResolvedValue(makeDetailRow("tier_b_review"));
    const myOwnReview = makeHumanReview({ reviewer_id: "checker-1", tier: "B", decision: "approve" });
    getReviewGateMock.mockResolvedValue({ kind: "tier_b", rationaleRequired: false, existingDecision: myOwnReview });

    const res = await callRoute(makeRequest());
    const body = await res.json();
    expect(body.reviewGate.existingDecision.reviewer_id).toBe("checker-1");
  });
});

describe("GET /api/console/items/:obligationId — FR-9 (literal, unmodified source clause text)", () => {
  // FR-9's full requirement also covers frontend visual distinction (quote
  // styling vs. every other block) — that half is UI rendering, not
  // testable in this node-environment suite (see FR-TRACEABILITY.md). This
  // test covers the data-contract half this route handler actually owns:
  // sourceClause.text must be the literal Clause.text string, verbatim —
  // no summarization, no truncation.
  it("passes Clause.text through byte-for-byte, unmodified — no truncation or summarization", async () => {
    const literalText =
      "Every regulated entity shall file a quarterly report within thirty days of the end of each quarter, in the format specified in Annexure B, failing which a penalty under clause 15 shall apply.";
    fetchObligationDetailMock.mockResolvedValue({
      ...makeDetailRow("tier_b_review"),
      clause: makeClause({ text: literalText })
    });
    getReviewGateMock.mockResolvedValue({ kind: "tier_b", rationaleRequired: false, existingDecision: null });

    const res = await callRoute(makeRequest({ "x-dev-reviewer-id": "rev-1", "x-dev-reviewer-role": "compliance_officer" }));
    const body = await res.json();
    expect(body.sourceClause.text).toBe(literalText);
  });
});

describe("GET /api/console/items/:obligationId — FR-14 (LineageBreadcrumb data assembly)", () => {
  it("assembles lineage as [Circular, Clause(para_ref), Obligation, ProcessTask] in order, Obligation step linked to its own detail view", async () => {
    fetchObligationDetailMock.mockResolvedValue(makeDetailRow("tier_b_review"));
    getReviewGateMock.mockResolvedValue({ kind: "tier_b", rationaleRequired: false, existingDecision: null });

    const res = await callRoute(makeRequest({ "x-dev-reviewer-id": "rev-1", "x-dev-reviewer-role": "compliance_officer" }));
    const body = await res.json();
    expect(body.lineage).toEqual([
      { label: "SEBI Circular on Quarterly Reporting" },
      { label: "Clause 3.2" },
      { label: "Obligation obligation-1", href: "/queue/obligation-1" },
      { label: "ProcessTask task-1" }
    ]);
  });

  it("omits the ProcessTask lineage step when the Obligation has no mapped ProcessTask", async () => {
    fetchObligationDetailMock.mockResolvedValue({ ...makeDetailRow("tier_b_review"), processTask: null });
    getReviewGateMock.mockResolvedValue({ kind: "tier_b", rationaleRequired: false, existingDecision: null });

    const res = await callRoute(makeRequest({ "x-dev-reviewer-id": "rev-1", "x-dev-reviewer-role": "compliance_officer" }));
    const body = await res.json();
    expect(body.lineage.map((step: { label: string }) => step.label)).toEqual([
      "SEBI Circular on Quarterly Reporting",
      "Clause 3.2",
      "Obligation obligation-1"
    ]);
  });
});

describe("GET /api/console/items/:obligationId — FR-12 / AC-8 (no-prior-ProcessTask 'New task' rendering path)", () => {
  // This app's chosen representation (see types.ts's ProcessTaskDiff doc
  // comment): processTaskDiff is null ONLY when the Obligation has no
  // ProcessTask mapped at all (no Change-and-Delta origin whatsoever).
  // When a ProcessTask exists but there is no PRIOR one (the actual
  // "first-version obligation" case AC-8/FR-12's prose describes),
  // processTaskDiff is non-null with redline.oldTaskId: null and
  // overallStatus: "new" — diff-adapter.ts's deriveEmptyOldLabel/
  // needsDiffToggle (already unit-tested in diff-adapter.test.ts) is what
  // turns THAT shape into the "New task" plain-list rendering. Both real
  // data states are exercised here; see FR-TRACEABILITY.md for a note on
  // this terminology nuance vs. AC-8's literal wording.
  it("processTaskDiff is null when there is no ProcessTask at all (no Change-and-Delta origin)", async () => {
    fetchObligationDetailMock.mockResolvedValue({ ...makeDetailRow("tier_b_review"), processTask: null });
    getReviewGateMock.mockResolvedValue({ kind: "tier_b", rationaleRequired: false, existingDecision: null });

    const res = await callRoute(makeRequest({ "x-dev-reviewer-id": "rev-1", "x-dev-reviewer-role": "compliance_officer" }));
    const body = await res.json();
    expect(body.processTaskDiff).toBeNull();
  });

  it("processTaskDiff.redline.oldTaskId is null and overallStatus is 'new' when a ProcessTask exists but there is no PRIOR one (first-version obligation)", async () => {
    fetchObligationDetailMock.mockResolvedValue({ ...makeDetailRow("tier_b_review"), priorObligation: null, priorProcessTask: null });
    getReviewGateMock.mockResolvedValue({ kind: "tier_b", rationaleRequired: false, existingDecision: null });

    const res = await callRoute(makeRequest({ "x-dev-reviewer-id": "rev-1", "x-dev-reviewer-role": "compliance_officer" }));
    const body = await res.json();
    expect(body.processTaskDiff).not.toBeNull();
    expect(body.processTaskDiff.redline.oldTaskId).toBeNull();
    expect(body.processTaskDiff.redline.overallStatus).toBe("new");
    // Every field diff entry is "added" (nothing to compare against), never
    // a misleading "changed from nothing" — matches diff-adapter.ts's own
    // FR-12 handling of this exact case.
    expect(body.processTaskDiff.redline.fields.every((f: { status: string }) => f.status === "added")).toBe(true);
  });
});
