// Spec 10 §10 API route tests — GET /api/audit/reviews. Mirrors Spec 09's
// queue/route.test.ts pattern exactly: vi.mock the service-layer module
// (@sentinel-act/graph-db's AuditQueryService) before importing the route
// handler, construct a NextRequest directly, call the handler, assert on
// status/body.
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { searchMock, AuditQueryServiceMock } = vi.hoisted(() => {
  const searchMock = vi.fn();
  return { searchMock, AuditQueryServiceMock: vi.fn().mockImplementation(() => ({ search: searchMock })) };
});

vi.mock("@sentinel-act/graph-db", async () => {
  const actual = await vi.importActual<typeof import("@sentinel-act/graph-db")>("@sentinel-act/graph-db");
  return { ...actual, getDriver: vi.fn(() => ({})), AuditQueryService: AuditQueryServiceMock };
});

import { GET } from "./route";

const OBSERVER_HEADERS = { "x-dev-reviewer-id": "auditor-1", "x-dev-reviewer-role": "compliance_head" };
const OPERATOR_HEADERS = { "x-dev-reviewer-id": "reviewer-1", "x-dev-reviewer-role": "compliance_officer" };

function makeRequest(searchParams: Record<string, string> = {}, headers: Record<string, string> = OBSERVER_HEADERS): NextRequest {
  const url = new URL("http://localhost/api/audit/reviews");
  for (const [key, value] of Object.entries(searchParams)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url, { method: "GET", headers });
}

const EMPTY_RESPONSE = { rows: [], totalCount: 0, page: 1, pageSize: 50 };

beforeEach(() => {
  searchMock.mockReset();
  searchMock.mockResolvedValue(EMPTY_RESPONSE);
});

describe("GET /api/audit/reviews", () => {
  // NFR-5: requireRole(["observer","admin"]) stub — 401 (no session).
  it("401 when no session is present", async () => {
    const response = await GET(makeRequest({}, {}));
    expect(response.status).toBe(401);
  });

  // NFR-5: requireRole stub — 403 (valid session, wrong role).
  it("403 for a non-observer-mode role (compliance_officer)", async () => {
    const response = await GET(makeRequest({}, OPERATOR_HEADERS));
    expect(response.status).toBe(403);
    expect(searchMock).not.toHaveBeenCalled();
  });

  // FR-1: every AuditQueryFilters field, forwarded combinably in one
  // request (all supplied simultaneously here).
  it("200 with a successful search, forwarding every filter", async () => {
    const response = await GET(
      makeRequest({
        obligationId: "ob-1",
        circularId: "circ-1",
        reviewerId: "alice",
        freeText: "disclosure",
        tier: "B",
        decision: "approve",
        decidedFrom: "2026-01-01",
        decidedTo: "2026-01-31",
        page: "2",
        pageSize: "25"
      })
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(EMPTY_RESPONSE);
    expect(searchMock).toHaveBeenCalledWith({
      obligationId: "ob-1",
      circularId: "circ-1",
      reviewerId: "alice",
      freeText: "disclosure",
      tier: "B",
      decision: "approve",
      decidedFrom: "2026-01-01",
      decidedTo: "2026-01-31",
      page: 2,
      pageSize: 25
    });
  });

  it("passes tier=A through with no special-case bypass (FR-6)", async () => {
    const response = await GET(makeRequest({ tier: "A" }));
    expect(response.status).toBe(200);
    expect(searchMock).toHaveBeenCalledWith(expect.objectContaining({ tier: "A" }));
  });

  it("400 with { error, field } for an invalid tier value, before AuditQueryService is called", async () => {
    const response = await GET(makeRequest({ tier: "Z" }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.field).toBe("tier");
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("400 for an invalid decidedFrom date", async () => {
    const response = await GET(makeRequest({ decidedFrom: "not-a-date" }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.field).toBe("decidedFrom");
  });

  it("400 for pageSize > 200", async () => {
    const response = await GET(makeRequest({ pageSize: "201" }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.field).toBe("pageSize");
  });

  // AC-6: a non-matching reviewerId filter is 200 { rows: [], totalCount: 0
  // }, not a 404/500.
  it("empty rows for a reviewerId that matches nothing is 200, not 404/500", async () => {
    searchMock.mockResolvedValueOnce({ rows: [], totalCount: 0, page: 1, pageSize: 50 });
    const response = await GET(makeRequest({ reviewerId: "no-such-reviewer" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ rows: [], totalCount: 0, page: 1, pageSize: 50 });
  });

  it("503 when AuditQueryService.search throws GraphDbUnavailableError", async () => {
    const { GraphDbUnavailableError } = await vi.importActual<typeof import("@sentinel-act/graph-db")>("@sentinel-act/graph-db");
    searchMock.mockRejectedValueOnce(new GraphDbUnavailableError("down"));
    const response = await GET(makeRequest({}));
    expect(response.status).toBe(503);
  });

  it("504 when the underlying query reports a timeout", async () => {
    const timeoutError = new Error("transaction timed out");
    searchMock.mockRejectedValueOnce(timeoutError);
    const response = await GET(makeRequest({}));
    expect(response.status).toBe(504);
  });

  it("500 for an unrecognized error", async () => {
    searchMock.mockRejectedValueOnce(new Error("boom"));
    const response = await GET(makeRequest({}));
    expect(response.status).toBe(500);
  });
});
