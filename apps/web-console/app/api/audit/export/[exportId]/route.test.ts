import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const findMock = vi.fn();
  const markFailedMock = vi.fn();
  const ExportJobStoreMock = vi.fn().mockImplementation(() => ({ find: findMock, markFailed: markFailedMock }));
  return { findMock, markFailedMock, ExportJobStoreMock };
});

vi.mock("@sentinel-act/graph-db", async () => {
  const actual = await vi.importActual<typeof import("@sentinel-act/graph-db")>("@sentinel-act/graph-db");
  return { ...actual, getDriver: vi.fn(() => ({})), ExportJobStore: mocks.ExportJobStoreMock };
});

import { GET } from "./route";

const OBSERVER_HEADERS = { "x-dev-reviewer-id": "auditor-1", "x-dev-reviewer-role": "compliance_head" };
const OPERATOR_HEADERS = { "x-dev-reviewer-id": "reviewer-1", "x-dev-reviewer-role": "compliance_officer" };

function makeRequest(headers: Record<string, string> = OBSERVER_HEADERS): NextRequest {
  return new NextRequest(new URL("http://localhost/api/audit/export/exp-1"), { method: "GET", headers });
}

function makeParams(exportId: string) {
  return { params: Promise.resolve({ exportId }) };
}

function baseJob(overrides: Record<string, unknown> = {}) {
  return {
    exportId: "exp-1",
    status: "queued",
    requestedAt: new Date().toISOString(),
    requestedBy: "auditor-1",
    asOfDate: "2026-07-01",
    format: "xlsx",
    filters: undefined,
    rowCount: null,
    filePath: null,
    fileSizeBytes: null,
    errorMessage: null,
    completedAt: null,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/audit/export/:exportId", () => {
  it("401 when no session is present", async () => {
    const response = await GET(makeRequest({}), makeParams("exp-1"));
    expect(response.status).toBe(401);
  });

  it("403 for a non-observer-mode role", async () => {
    const response = await GET(makeRequest(OPERATOR_HEADERS), makeParams("exp-1"));
    expect(response.status).toBe(403);
  });

  it("404 for an unknown exportId", async () => {
    mocks.findMock.mockResolvedValueOnce(null);
    const response = await GET(makeRequest(), makeParams("does-not-exist"));
    expect(response.status).toBe(404);
  });

  it("200 with the job for a known, non-stale exportId", async () => {
    mocks.findMock.mockResolvedValueOnce(baseJob({ status: "running" }));
    const response = await GET(makeRequest(), makeParams("exp-1"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("running");
    expect(mocks.markFailedMock).not.toHaveBeenCalled();
  });

  it("lazily flips a job stuck 'running' for > 10 minutes to 'failed' (§8)", async () => {
    const staleRequestedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    mocks.findMock.mockResolvedValueOnce(baseJob({ status: "running", requestedAt: staleRequestedAt }));
    mocks.findMock.mockResolvedValueOnce(baseJob({ status: "failed", requestedAt: staleRequestedAt, errorMessage: "generation did not complete, please retry" }));

    const response = await GET(makeRequest(), makeParams("exp-1"));

    expect(mocks.markFailedMock).toHaveBeenCalledWith("exp-1", "generation did not complete, please retry");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("failed");
  });

  // FR-13 / Acceptance Criterion 7: the poll target eventually reports
  // status: "completed" with the fields a working download link needs.
  it("200 with a completed job", async () => {
    mocks.findMock.mockResolvedValueOnce(baseJob({ status: "completed", rowCount: 3, filePath: "/tmp/exp-1.xlsx", fileSizeBytes: 100 }));
    const response = await GET(makeRequest(), makeParams("exp-1"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("completed");
    expect(body.rowCount).toBe(3);
  });
});
