// Spec 09 §12: BFF route-handler integration tests for
// `POST /api/console/items/:obligationId/claim`. Covers §8's error-mapping
// table for this route: 404 NOT_FOUND, 422 NOT_TIER_C, 409 SLOT_UNAVAILABLE
// (slot exhaustion — both maker/checker slots already taken), 502
// ORCHESTRATOR_UNAVAILABLE, and a well-formed non-2xx Orchestrator
// passthrough.
//
// Note on "self-review rejection": verified by reading
// apps/orchestrator/src/mastra/workflows/orchestrator.workflow.ts in full —
// `handleClaimRequest` (backing this route) has no maker/checker identity
// check at all; `ReviewerIndependenceError`/SELF_REVIEW_FORBIDDEN is only
// ever thrown by `resumeOrchestratorRun` (i.e. at DECISION-SUBMIT time, not
// claim time) when the same reviewer_id is about to fill both slots. That
// case is exercised in
// app/api/console/items/[obligationId]/decisions/route.test.ts's
// "403 SELF_REVIEW_FORBIDDEN passes through" test, not here — there is no
// equivalent claim-time check to test.
//
// See apps/web-console/lib/console/FR-TRACEABILITY.md for the full FR/AC
// coverage ledger.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { makeObligation } from "@/lib/console/test-fixtures";

const { findByIdMock, getDriverMock } = vi.hoisted(() => ({
  findByIdMock: vi.fn(),
  getDriverMock: vi.fn(() => ({}))
}));
vi.mock("@sentinel-act/graph-db", async () => {
  const actual = await vi.importActual<typeof import("@sentinel-act/graph-db")>("@sentinel-act/graph-db");
  return {
    ...actual,
    getDriver: getDriverMock,
    ObligationRepository: class {
      findById = findByIdMock;
    }
  };
});

const { claimSlotMock } = vi.hoisted(() => ({ claimSlotMock: vi.fn() }));
vi.mock("@/lib/console/orchestrator-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/console/orchestrator-client")>("@/lib/console/orchestrator-client");
  return { ...actual, claimSlot: claimSlotMock };
});

import { POST } from "./route";
import { OrchestratorResponseError, OrchestratorUnavailableError } from "@/lib/console/orchestrator-client";

function makeRequest(headers: Record<string, string> = { "x-dev-reviewer-id": "maker-1", "x-dev-reviewer-role": "senior_compliance_officer" }) {
  return new NextRequest("http://localhost/api/console/items/obligation-1/claim", { method: "POST", headers });
}

function callRoute(req: NextRequest, obligationId = "obligation-1") {
  return POST(req, { params: Promise.resolve({ obligationId }) });
}

beforeEach(() => {
  findByIdMock.mockReset();
  getDriverMock.mockClear();
  claimSlotMock.mockReset();
});

describe("POST claim — auth", () => {
  it("401s with no reviewer session", async () => {
    const res = await callRoute(makeRequest({}));
    expect(res.status).toBe(401);
  });

  it("403s for compliance_head before any Orchestrator call", async () => {
    const res = await callRoute(makeRequest({ "x-dev-reviewer-id": "obs-1", "x-dev-reviewer-role": "compliance_head" }));
    expect(res.status).toBe(403);
    expect(findByIdMock).not.toHaveBeenCalled();
  });
});

describe("POST claim — validation", () => {
  it("404s when the obligation does not exist", async () => {
    findByIdMock.mockResolvedValue(null);
    const res = await callRoute(makeRequest());
    expect(res.status).toBe(404);
  });

  it("422 NOT_TIER_C when the obligation is Tier B (claiming is a Tier-C-only concept)", async () => {
    findByIdMock.mockResolvedValue(makeObligation({ status: "tier_b_review" }));
    const res = await callRoute(makeRequest());
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("NOT_TIER_C");
    expect(claimSlotMock).not.toHaveBeenCalled();
  });

  it("422 NOT_TIER_C when the obligation is ESCALATE (also not a claim-eligible tier)", async () => {
    findByIdMock.mockResolvedValue(makeObligation({ status: "escalated" }));
    const res = await callRoute(makeRequest());
    expect(res.status).toBe(422);
  });
});

// FR-20 / AC-7: the Orchestrator's real claim endpoint collapses both
// "you already hold a slot" (self-review, ALREADY_CLAIMED_BY_SELF) and
// "both slots taken by others" (NO_SLOTS_AVAILABLE) into a single 409
// (verified against http-server.ts's handleClaim — see this file's own
// top-of-file doc comment); this route passes that through as
// SLOT_UNAVAILABLE, a documented superset of Spec 09 §5.1's two literal
// codes. This test is the BFF-level half of FR-20/AC-7's self-review/
// slot-exhaustion rejection — see FR-TRACEABILITY.md for why the
// Orchestrator-side distinction itself (which of the two sub-cases fired)
// is not independently testable from this app.
describe("POST claim — slot exhaustion / Orchestrator error mapping", () => {
  it("409 SLOT_UNAVAILABLE when both maker/checker slots are already taken (FR-20, AC-7)", async () => {
    findByIdMock.mockResolvedValue(makeObligation({ status: "tier_c_review" }));
    claimSlotMock.mockResolvedValue({ status: 409 });
    const res = await callRoute(makeRequest());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("SLOT_UNAVAILABLE");
  });

  it("502 ORCHESTRATOR_UNAVAILABLE when the Orchestrator is unreachable (claim not recorded, retry-safe)", async () => {
    findByIdMock.mockResolvedValue(makeObligation({ status: "tier_c_review" }));
    claimSlotMock.mockRejectedValue(new OrchestratorUnavailableError("claimSlot", new Error("ECONNREFUSED")));
    const res = await callRoute(makeRequest());
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("ORCHESTRATOR_UNAVAILABLE");
  });

  it("passes through a well-formed non-2xx Orchestrator error verbatim", async () => {
    findByIdMock.mockResolvedValue(makeObligation({ status: "tier_c_review" }));
    claimSlotMock.mockRejectedValue(new OrchestratorResponseError("claimSlot", 400, "ORCHESTRATOR_ERROR", "malformed claim request"));
    const res = await callRoute(makeRequest());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("ORCHESTRATOR_ERROR");
  });
});

describe("POST claim — happy path", () => {
  it("200s with viewerSlot + status: claimed_by_viewer on a successful claim (FR-20)", async () => {
    findByIdMock.mockResolvedValue(makeObligation({ status: "tier_c_review" }));
    claimSlotMock.mockResolvedValue({ status: 200, slot: "maker" });
    const res = await callRoute(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ viewerSlot: "maker", status: "claimed_by_viewer" });
  });

  it("claimSlot is called with the SESSION's reviewerId, not a client-suppliable value (NFR-Security-2)", async () => {
    findByIdMock.mockResolvedValue(makeObligation({ status: "tier_c_review" }));
    claimSlotMock.mockResolvedValue({ status: 200, slot: "checker" });
    await callRoute(makeRequest({ "x-dev-reviewer-id": "checker-9", "x-dev-reviewer-role": "compliance_officer" }));
    expect(claimSlotMock).toHaveBeenCalledWith({ obligationId: "obligation-1", reviewerId: "checker-9" });
  });
});
