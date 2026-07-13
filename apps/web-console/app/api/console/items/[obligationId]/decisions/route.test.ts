// Spec 09 §12: BFF route-handler integration tests for
// `POST /api/console/items/:obligationId/decisions`, calling the exported
// `POST` handler directly (constructed `NextRequest`, no running Next
// server) with `@sentinel-act/graph-db` (ObligationRepository/getDriver) and
// `@/lib/console/orchestrator-client` (getRunRef/submitDecision/getReviewGate)
// mocked. Covers Spec 09 §8's error-mapping table: rationale-required 400,
// invalid decision enum 400, ACTION_NOT_ALLOWED_FOR_TIER 403 (FR-27),
// ALREADY_DECIDED 409 (FR-30 idempotency), SELF_REVIEW_FORBIDDEN 403
// passthrough ("claim self-review rejection"), escalate_to_tier_c's
// 501/400 split, and the happy path.
//
// See apps/web-console/lib/console/FR-TRACEABILITY.md for the full FR/AC
// coverage ledger, including which requirements this suite deliberately
// does NOT claim to cover and why (e.g. FR-28's documented 501 gap below,
// FR-31/FR-32 which have no implementation to test at all).
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

const { getReviewGateMock, getRunRefMock, submitDecisionMock } = vi.hoisted(() => ({
  getReviewGateMock: vi.fn(),
  getRunRefMock: vi.fn(),
  submitDecisionMock: vi.fn()
}));
vi.mock("@/lib/console/orchestrator-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/console/orchestrator-client")>("@/lib/console/orchestrator-client");
  return { ...actual, getReviewGate: getReviewGateMock, getRunRef: getRunRefMock, submitDecision: submitDecisionMock };
});

import { POST } from "./route";
import { OrchestratorResponseError, OrchestratorUnavailableError } from "@/lib/console/orchestrator-client";

function makeRequest(body: unknown, headers: Record<string, string> = { "x-dev-reviewer-id": "checker-1", "x-dev-reviewer-role": "senior_compliance_officer" }) {
  return new NextRequest("http://localhost/api/console/items/obligation-1/decisions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

function callRoute(req: NextRequest, obligationId = "obligation-1") {
  return POST(req, { params: Promise.resolve({ obligationId }) });
}

beforeEach(() => {
  findByIdMock.mockReset();
  getDriverMock.mockClear();
  getReviewGateMock.mockReset();
  getRunRefMock.mockReset();
  submitDecisionMock.mockReset();
  // Sensible defaults for the happy-path-adjacent tests; individual tests
  // override as needed.
  getRunRefMock.mockResolvedValue({ runId: "run-1", stepId: "awaitHumanReview" });
  submitDecisionMock.mockResolvedValue({ resumed: true, finalStatus: "tier_b_review" });
  getReviewGateMock.mockResolvedValue({ kind: "tier_b", rationaleRequired: false, existingDecision: null });
});

describe("POST decisions — auth", () => {
  it("401s with no reviewer session", async () => {
    findByIdMock.mockResolvedValue(makeObligation({ status: "tier_b_review" }));
    const res = await callRoute(makeRequest({ decision: "approve", rationale: null }, {}));
    expect(res.status).toBe(401);
  });

  it("403s for compliance_head before any Orchestrator call", async () => {
    const res = await callRoute(
      makeRequest({ decision: "approve", rationale: null }, { "x-dev-reviewer-id": "obs-1", "x-dev-reviewer-role": "compliance_head" })
    );
    expect(res.status).toBe(403);
    expect(findByIdMock).not.toHaveBeenCalled();
  });
});

describe("POST decisions — request validation", () => {
  it("400 INVALID_DECISION for an unrecognized decision enum value", async () => {
    const res = await callRoute(makeRequest({ decision: "banana", rationale: "why not" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("INVALID_DECISION");
  });

  it("400 INVALID_DECISION when the body is malformed (not an object)", async () => {
    const res = await callRoute(makeRequest("not-an-object"));
    expect(res.status).toBe(400);
  });

  it("404 NOT_FOUND when the obligation does not exist", async () => {
    findByIdMock.mockResolvedValue(null);
    const res = await callRoute(makeRequest({ decision: "approve", rationale: null }));
    expect(res.status).toBe(404);
  });

  it("409 SUSPENDED_STEP_NOT_FOUND when the obligation is not currently in a reviewable status", async () => {
    findByIdMock.mockResolvedValue(makeObligation({ status: "committed" }));
    const res = await callRoute(makeRequest({ decision: "approve", rationale: null }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("SUSPENDED_STEP_NOT_FOUND");
  });
});

describe("POST decisions — FR-27 (no approve on ESCALATE)", () => {
  // AC-4: approve on an ESCALATE item -> 403, and no HumanReview is
  // written (submitDecisionMock never called proves nothing was submitted
  // to the Orchestrator's resume/write path).
  it("403 ACTION_NOT_ALLOWED_FOR_TIER when decision=approve on an ESCALATE item", async () => {
    findByIdMock.mockResolvedValue(makeObligation({ status: "escalated" }));
    const res = await callRoute(makeRequest({ decision: "approve", rationale: "fine" }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("ACTION_NOT_ALLOWED_FOR_TIER");
    expect(submitDecisionMock).not.toHaveBeenCalled();
  });

  it("reject IS allowed on an ESCALATE item (with rationale)", async () => {
    findByIdMock.mockResolvedValue(makeObligation({ status: "escalated" }));
    submitDecisionMock.mockResolvedValue({ resumed: true, finalStatus: "rejected" });
    const res = await callRoute(makeRequest({ decision: "reject", rationale: "conflicts with existing obligation" }));
    expect(res.status).toBe(200);
  });
});

// FR-28: honestly, this is NOT MET by the current implementation — FR-28
// requires "escalate_to_tier_c" on an ESCALATE item to transition
// Obligation.status to "tier_c_review" and re-route into the Tier C flow.
// This route deliberately does NOT do that: per its own top-of-file doc
// comment (verified against the real orchestrator workflow graph), an
// ESCALATE item already runs through the identical dual-review suspend/
// claim mechanics as Tier C from the moment it is routed, so there is no
// separate pre-Tier-C state left to transition out of, and
// recordHumanReview only accepts "approve"|"reject" on the wire — there is
// no orchestrator-side mechanism this route could call to satisfy FR-28
// even if it tried. This test documents the resulting, intentional 501 gap
// rather than pretend FR-28 is satisfied; see FR-TRACEABILITY.md.
describe("POST decisions — escalate_to_tier_c (no real Orchestrator mechanism)", () => {
  it("501 NOT_IMPLEMENTED for escalate_to_tier_c on an ESCALATE item (FR-28 gap, documented not satisfied — see comment above)", async () => {
    findByIdMock.mockResolvedValue(makeObligation({ status: "escalated" }));
    const res = await callRoute(makeRequest({ decision: "escalate_to_tier_c", rationale: null }));
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error).toBe("NOT_IMPLEMENTED");
    expect(submitDecisionMock).not.toHaveBeenCalled();
  });

  it("400 INVALID_DECISION for escalate_to_tier_c on a non-ESCALATE item (Tier B)", async () => {
    findByIdMock.mockResolvedValue(makeObligation({ status: "tier_b_review" }));
    const res = await callRoute(makeRequest({ decision: "escalate_to_tier_c", rationale: null }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("INVALID_DECISION");
  });
});

describe("POST decisions — FR-25 rationale required at Tier C / ESCALATE", () => {
  it("400 RATIONALE_REQUIRED at Tier C with empty rationale", async () => {
    findByIdMock.mockResolvedValue(makeObligation({ status: "tier_c_review" }));
    const res = await callRoute(makeRequest({ decision: "approve", rationale: "" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("RATIONALE_REQUIRED");
  });

  it("400 RATIONALE_REQUIRED at Tier C with whitespace-only rationale", async () => {
    findByIdMock.mockResolvedValue(makeObligation({ status: "tier_c_review" }));
    const res = await callRoute(makeRequest({ decision: "approve", rationale: "   " }));
    expect(res.status).toBe(400);
  });

  it("400 RATIONALE_REQUIRED at Tier C with rationale omitted (null)", async () => {
    findByIdMock.mockResolvedValue(makeObligation({ status: "tier_c_review" }));
    const res = await callRoute(makeRequest({ decision: "approve", rationale: null }));
    expect(res.status).toBe(400);
  });

  it("Tier B does NOT require rationale — succeeds with rationale: null", async () => {
    findByIdMock.mockResolvedValue(makeObligation({ status: "tier_b_review" }));
    const res = await callRoute(makeRequest({ decision: "approve", rationale: null }));
    expect(res.status).toBe(200);
  });

  it("Tier C succeeds once a non-empty rationale is provided", async () => {
    findByIdMock.mockResolvedValue(makeObligation({ status: "tier_c_review" }));
    const res = await callRoute(makeRequest({ decision: "approve", rationale: "reviewed and correct" }));
    expect(res.status).toBe(200);
  });
});

describe("POST decisions — Orchestrator transport/domain error mapping", () => {
  it("409 SUSPENDED_STEP_NOT_FOUND when getRunRef finds no suspended run", async () => {
    findByIdMock.mockResolvedValue(makeObligation({ status: "tier_b_review" }));
    getRunRefMock.mockResolvedValue(null);
    const res = await callRoute(makeRequest({ decision: "approve", rationale: null }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("SUSPENDED_STEP_NOT_FOUND");
  });

  // AC-6: resending an identical decision (double-click/retry) returns 409
  // ALREADY_DECIDED and never creates a second HumanReview node for the
  // same (obligationId, reviewerId) pair — submitDecisionMock reporting
  // resumed: false is exactly the Orchestrator signaling "this was already
  // recorded, no second write happened."
  it("409 ALREADY_DECIDED when the Orchestrator reports resumed: false (FR-30 idempotency, AC-6)", async () => {
    findByIdMock.mockResolvedValue(makeObligation({ status: "tier_b_review" }));
    submitDecisionMock.mockResolvedValue({ resumed: false, finalStatus: "still_pending" });
    const res = await callRoute(makeRequest({ decision: "approve", rationale: null }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("ALREADY_DECIDED");
  });

  it("403 SELF_REVIEW_FORBIDDEN passes through when the Orchestrator rejects a maker resubmitting as checker", async () => {
    findByIdMock.mockResolvedValue(makeObligation({ status: "tier_c_review" }));
    submitDecisionMock.mockRejectedValue(new OrchestratorResponseError("submitDecision", 403, "SELF_REVIEW_FORBIDDEN", "same reviewer cannot fill both slots."));
    const res = await callRoute(makeRequest({ decision: "approve", rationale: "reviewed" }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("SELF_REVIEW_FORBIDDEN");
  });

  // FR-31: the Orchestrator is the authoritative source of truth for
  // maker/checker slot assignment (SuspendedRunIndexPort.getClaimSlots) —
  // this BFF does not duplicate that check itself, it just passes the
  // Orchestrator's 403 NOT_ASSIGNED straight through, same passthrough
  // pattern as SELF_REVIEW_FORBIDDEN above (mapOrchestratorTransportError
  // in route.ts handles any OrchestratorResponseError generically).
  it("403 NOT_ASSIGNED passes through when the Orchestrator rejects a reviewer who never claimed their slot", async () => {
    findByIdMock.mockResolvedValue(makeObligation({ status: "tier_c_review" }));
    submitDecisionMock.mockRejectedValue(
      new OrchestratorResponseError("submitDecision", 403, "NOT_ASSIGNED", "reviewer does not hold the claimed maker slot.")
    );
    const res = await callRoute(makeRequest({ decision: "approve", rationale: "reviewed" }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("NOT_ASSIGNED");
  });

  it("502 ORCHESTRATOR_UNAVAILABLE when submitDecision throws a transport error (decision is retry-safe, not silently dropped)", async () => {
    findByIdMock.mockResolvedValue(makeObligation({ status: "tier_b_review" }));
    submitDecisionMock.mockRejectedValue(new OrchestratorUnavailableError("submitDecision", new Error("ECONNREFUSED")));
    const res = await callRoute(makeRequest({ decision: "approve", rationale: null }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("ORCHESTRATOR_UNAVAILABLE");
  });

  it("502 ORCHESTRATOR_UNAVAILABLE when getRunRef itself is unreachable", async () => {
    findByIdMock.mockResolvedValue(makeObligation({ status: "tier_b_review" }));
    getRunRefMock.mockRejectedValue(new OrchestratorUnavailableError("getRunRef", new Error("ECONNREFUSED")));
    const res = await callRoute(makeRequest({ decision: "approve", rationale: null }));
    expect(res.status).toBe(502);
  });
});

describe("POST decisions — happy path", () => {
  it("200s, uses the SESSION's reviewerId (never a client-supplied one) as humanReview.reviewer_id", async () => {
    findByIdMock.mockResolvedValue(makeObligation({ status: "tier_b_review" }));
    submitDecisionMock.mockResolvedValue({ resumed: true, finalStatus: "tier_b_review" });

    // Even if a malicious client tries to smuggle a reviewerId in the body,
    // the route never reads it (NFR-Security-2) — only { decision, rationale }
    // are parsed off the body at all.
    const res = await callRoute(
      makeRequest({ decision: "approve", rationale: null, reviewerId: "someone-else" }, {
        "x-dev-reviewer-id": "checker-1",
        "x-dev-reviewer-role": "senior_compliance_officer"
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.humanReview.reviewer_id).toBe("checker-1");
    expect(body.humanReview.decision).toBe("approve");
  });

  it("submitDecision is called with the tier resolved server-side from the Obligation's status, not from the request body", async () => {
    findByIdMock.mockResolvedValue(makeObligation({ status: "tier_c_review" }));
    submitDecisionMock.mockResolvedValue({ resumed: true, finalStatus: "tier_c_review" });
    await callRoute(makeRequest({ decision: "approve", rationale: "reviewed" }));
    expect(submitDecisionMock).toHaveBeenCalledWith(expect.objectContaining({ review: expect.objectContaining({ tier: "C" }) }));
  });
});
