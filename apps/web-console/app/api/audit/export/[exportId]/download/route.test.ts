import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const findMock = vi.fn();
  const readExportFileMock = vi.fn();
  const ExportJobStoreMock = vi.fn().mockImplementation(() => ({ find: findMock }));
  return { findMock, readExportFileMock, ExportJobStoreMock };
});

vi.mock("@sentinel-act/graph-db", async () => {
  const actual = await vi.importActual<typeof import("@sentinel-act/graph-db")>("@sentinel-act/graph-db");
  return { ...actual, getDriver: vi.fn(() => ({})), ExportJobStore: mocks.ExportJobStoreMock };
});

vi.mock("@/lib/console/export-storage", () => ({
  readExportFile: mocks.readExportFileMock
}));

import { GET } from "./route";

const OBSERVER_HEADERS = { "x-dev-reviewer-id": "auditor-1", "x-dev-reviewer-role": "compliance_head" };
const OPERATOR_HEADERS = { "x-dev-reviewer-id": "reviewer-1", "x-dev-reviewer-role": "compliance_officer" };

function makeRequest(headers: Record<string, string> = OBSERVER_HEADERS): NextRequest {
  return new NextRequest(new URL("http://localhost/api/audit/export/exp-1/download"), { method: "GET", headers });
}

function makeParams(exportId: string) {
  return { params: Promise.resolve({ exportId }) };
}

function baseJob(overrides: Record<string, unknown> = {}) {
  return {
    exportId: "exp-1",
    status: "completed",
    requestedAt: new Date().toISOString(),
    requestedBy: "auditor-1",
    asOfDate: "2026-07-01",
    format: "xlsx",
    filters: undefined,
    rowCount: 1,
    filePath: "/tmp/exp-1.xlsx",
    fileSizeBytes: 11,
    errorMessage: null,
    completedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readExportFileMock.mockResolvedValue(Buffer.from("file-bytes"));
});

describe("GET /api/audit/export/:exportId/download", () => {
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

  it("409 when the job is still queued/running (not ready)", async () => {
    mocks.findMock.mockResolvedValueOnce(baseJob({ status: "running", filePath: null }));
    const response = await GET(makeRequest(), makeParams("exp-1"));
    expect(response.status).toBe(409);
    expect(mocks.readExportFileMock).not.toHaveBeenCalled();
  });

  it("500 when the job failed", async () => {
    mocks.findMock.mockResolvedValueOnce(baseJob({ status: "failed", filePath: null, errorMessage: "boom" }));
    const response = await GET(makeRequest(), makeParams("exp-1"));
    expect(response.status).toBe(500);
  });

  it("410 when the job has expired", async () => {
    mocks.findMock.mockResolvedValueOnce(baseJob({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
    const response = await GET(makeRequest(), makeParams("exp-1"));
    expect(response.status).toBe(410);
    expect(mocks.readExportFileMock).not.toHaveBeenCalled();
  });

  it("200 with correct headers for a completed xlsx job", async () => {
    mocks.findMock.mockResolvedValueOnce(baseJob({ format: "xlsx" }));
    const response = await GET(makeRequest(), makeParams("exp-1"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(response.headers.get("Content-Disposition")).toContain("attachment");
    expect(response.headers.get("Content-Disposition")).toContain("compliance-register-2026-07-01.xlsx");
    const buffer = Buffer.from(await response.arrayBuffer());
    expect(buffer.toString()).toBe("file-bytes");
  });

  it("200 with correct Content-Type for a completed pdf job", async () => {
    mocks.findMock.mockResolvedValueOnce(baseJob({ format: "pdf", filePath: "/tmp/exp-1.pdf" }));
    const response = await GET(makeRequest(), makeParams("exp-1"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
  });
});
