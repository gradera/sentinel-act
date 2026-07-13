import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findByReviewIdMock, AuditQueryServiceMock } = vi.hoisted(() => {
  const findByReviewIdMock = vi.fn();
  return { findByReviewIdMock, AuditQueryServiceMock: vi.fn().mockImplementation(() => ({ findByReviewId: findByReviewIdMock })) };
});

vi.mock("@sentinel-act/graph-db", async () => {
  const actual = await vi.importActual<typeof import("@sentinel-act/graph-db")>("@sentinel-act/graph-db");
  return { ...actual, getDriver: vi.fn(() => ({})), AuditQueryService: AuditQueryServiceMock };
});

import { GET } from "./route";

const OBSERVER_HEADERS = { "x-dev-reviewer-id": "auditor-1", "x-dev-reviewer-role": "compliance_head" };
const OPERATOR_HEADERS = { "x-dev-reviewer-id": "reviewer-1", "x-dev-reviewer-role": "compliance_officer" };

function makeRequest(headers: Record<string, string> = OBSERVER_HEADERS): NextRequest {
  return new NextRequest(new URL("http://localhost/api/audit/reviews/rev-1"), { method: "GET", headers });
}

function makeParams(reviewId: string) {
  return { params: Promise.resolve({ reviewId }) };
}

beforeEach(() => {
  findByReviewIdMock.mockReset();
});

describe("GET /api/audit/reviews/:reviewId", () => {
  // NFR-5.
  it("401 when no session is present", async () => {
    const response = await GET(makeRequest({}), makeParams("rev-1"));
    expect(response.status).toBe(401);
  });

  // NFR-5.
  it("403 for a non-observer-mode role", async () => {
    const response = await GET(makeRequest(OPERATOR_HEADERS), makeParams("rev-1"));
    expect(response.status).toBe(403);
    expect(findByReviewIdMock).not.toHaveBeenCalled();
  });

  // FR-10: 404 (not an empty 200) for an unknown review_id.
  it("404 when the review does not exist", async () => {
    findByReviewIdMock.mockResolvedValueOnce(null);
    const response = await GET(makeRequest(), makeParams("does-not-exist"));
    expect(response.status).toBe(404);
    expect(findByReviewIdMock).toHaveBeenCalledWith("does-not-exist");
  });

  // FR-10: full AuditTrailRow (lineage included) for a known review_id.
  it("200 with the full AuditTrailRow for a known review_id", async () => {
    const row = { review: { review_id: "rev-1" }, obligation: { obligation_id: "ob-1" }, clause: null, circular: null, processTasks: [] };
    findByReviewIdMock.mockResolvedValueOnce(row);
    const response = await GET(makeRequest(), makeParams("rev-1"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(row);
  });

  it("503 on GraphDbUnavailableError", async () => {
    const { GraphDbUnavailableError } = await vi.importActual<typeof import("@sentinel-act/graph-db")>("@sentinel-act/graph-db");
    findByReviewIdMock.mockRejectedValueOnce(new GraphDbUnavailableError("down"));
    const response = await GET(makeRequest(), makeParams("rev-1"));
    expect(response.status).toBe(503);
  });
});
