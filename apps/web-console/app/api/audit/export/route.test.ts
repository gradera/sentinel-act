// Spec 10 §10 API route tests — POST /api/audit/export. Mocks
// AuditQueryService/ExportJobStore (@sentinel-act/graph-db),
// toRegisterRows/generateXlsx/generatePdf (@sentinel-act/report-generation),
// and writeExportFile (lib/console/export-storage) — no real Neo4j, no
// real file I/O.
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const countRegisterAsOfMock = vi.fn();
  const findRegisterAsOfMock = vi.fn();
  const createMock = vi.fn();
  const countActiveJobsMock = vi.fn();
  const markRunningMock = vi.fn();
  const markCompletedMock = vi.fn();
  const markFailedMock = vi.fn();
  const findMock = vi.fn();
  const toRegisterRowsMock = vi.fn();
  const generateXlsxMock = vi.fn();
  const generatePdfMock = vi.fn();
  const writeExportFileMock = vi.fn();

  const AuditQueryServiceMock = vi.fn().mockImplementation(() => ({
    countRegisterAsOf: countRegisterAsOfMock,
    findRegisterAsOf: findRegisterAsOfMock
  }));
  const ExportJobStoreMock = vi.fn().mockImplementation(() => ({
    create: createMock,
    countActiveJobs: countActiveJobsMock,
    markRunning: markRunningMock,
    markCompleted: markCompletedMock,
    markFailed: markFailedMock,
    find: findMock
  }));

  return {
    countRegisterAsOfMock,
    findRegisterAsOfMock,
    createMock,
    countActiveJobsMock,
    markRunningMock,
    markCompletedMock,
    markFailedMock,
    findMock,
    toRegisterRowsMock,
    generateXlsxMock,
    generatePdfMock,
    writeExportFileMock,
    AuditQueryServiceMock,
    ExportJobStoreMock
  };
});

vi.mock("@sentinel-act/graph-db", async () => {
  const actual = await vi.importActual<typeof import("@sentinel-act/graph-db")>("@sentinel-act/graph-db");
  return { ...actual, getDriver: vi.fn(() => ({})), AuditQueryService: mocks.AuditQueryServiceMock, ExportJobStore: mocks.ExportJobStoreMock };
});

vi.mock("@sentinel-act/report-generation", () => ({
  toRegisterRows: mocks.toRegisterRowsMock,
  generateXlsx: mocks.generateXlsxMock,
  generatePdf: mocks.generatePdfMock
}));

vi.mock("@/lib/console/export-storage", () => ({
  writeExportFile: mocks.writeExportFileMock
}));

import { POST } from "./route";

const OBSERVER_HEADERS = { "x-dev-reviewer-id": "auditor-1", "x-dev-reviewer-role": "compliance_head", "content-type": "application/json" };
const OPERATOR_HEADERS = { "x-dev-reviewer-id": "reviewer-1", "x-dev-reviewer-role": "compliance_officer", "content-type": "application/json" };

function makeRequest(body: unknown, headers: Record<string, string> = OBSERVER_HEADERS): NextRequest {
  return new NextRequest(new URL("http://localhost/api/audit/export"), { method: "POST", headers, body: JSON.stringify(body) });
}

const VALID_BODY = { asOfDate: "2026-07-01", format: "xlsx" as const };

function baseJob(overrides: Record<string, unknown> = {}) {
  return {
    exportId: "exp-1",
    status: "queued",
    requestedAt: "2026-07-13T00:00:00.000Z",
    requestedBy: "auditor-1",
    asOfDate: "2026-07-01",
    format: "xlsx",
    filters: undefined,
    rowCount: null,
    filePath: null,
    fileSizeBytes: null,
    errorMessage: null,
    completedAt: null,
    expiresAt: "2026-07-20T00:00:00.000Z",
    ...overrides
  };
}

function flushMicrotasks(times = 5): Promise<void> {
  return Array.from({ length: times }).reduce<Promise<void>>((p) => p.then(() => new Promise((r) => setImmediate(r))), Promise.resolve());
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.countRegisterAsOfMock.mockResolvedValue(10);
  mocks.findRegisterAsOfMock.mockResolvedValue([{ obligation: { obligation_id: "ob-1" } }]);
  mocks.toRegisterRowsMock.mockReturnValue([{ obligation_id: "ob-1" }]);
  mocks.generateXlsxMock.mockReturnValue(Buffer.from("xlsx-bytes"));
  mocks.generatePdfMock.mockReturnValue(Buffer.from("pdf-bytes"));
  mocks.writeExportFileMock.mockResolvedValue({ filePath: "/tmp/exp-1.xlsx", fileSizeBytes: 11 });
  mocks.createMock.mockResolvedValue(baseJob());
  mocks.countActiveJobsMock.mockResolvedValue(0);
  mocks.markRunningMock.mockResolvedValue(undefined);
  mocks.markCompletedMock.mockResolvedValue(undefined);
  mocks.markFailedMock.mockResolvedValue(undefined);
  mocks.findMock.mockResolvedValue(baseJob({ status: "completed", rowCount: 1, filePath: "/tmp/exp-1.xlsx", fileSizeBytes: 11, completedAt: "2026-07-13T00:01:00.000Z" }));
  delete process.env.AUDIT_EXPORT_SYNC_ROW_THRESHOLD;
  delete process.env.AUDIT_EXPORT_MAX_CONCURRENT_JOBS;
});

describe("POST /api/audit/export", () => {
  // NFR-5.
  it("401 when no session is present", async () => {
    const response = await POST(makeRequest(VALID_BODY, { "content-type": "application/json" }));
    expect(response.status).toBe(401);
  });

  // NFR-5.
  it("403 for a non-observer-mode role", async () => {
    const response = await POST(makeRequest(VALID_BODY, OPERATOR_HEADERS));
    expect(response.status).toBe(403);
    expect(mocks.countRegisterAsOfMock).not.toHaveBeenCalled();
  });

  // FR-11: asOfDate is required, no silent "export current state" default.
  it("400 for a missing/invalid asOfDate", async () => {
    const response = await POST(makeRequest({ format: "xlsx" }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.field).toBe("asOfDate");
  });

  it("400 for an invalid format", async () => {
    const response = await POST(makeRequest({ asOfDate: "2026-07-01", format: "csv" }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.field).toBe("format");
  });

  // FR-12: a row-count estimate <= the sync threshold generates and
  // streams the file synchronously within the same request (200), no job
  // polling needed.
  it("sync path (rowCount <= threshold): generates inline and returns 200 with a completed job", async () => {
    mocks.countRegisterAsOfMock.mockResolvedValueOnce(10);
    const response = await POST(makeRequest(VALID_BODY));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("completed");
    expect(mocks.createMock).toHaveBeenCalledTimes(1);
    expect(mocks.findRegisterAsOfMock).toHaveBeenCalledTimes(1);
    expect(mocks.generateXlsxMock).toHaveBeenCalledTimes(1);
    expect(mocks.writeExportFileMock).toHaveBeenCalledWith("exp-1", "xlsx", expect.any(Buffer));
    expect(mocks.markCompletedMock).toHaveBeenCalledWith("exp-1", { rowCount: 1, filePath: "/tmp/exp-1.xlsx", fileSizeBytes: 11 });
  });

  it("requestedBy is ALWAYS taken from the session, never from the request body (FR-17)", async () => {
    mocks.countRegisterAsOfMock.mockResolvedValueOnce(10);
    const response = await POST(makeRequest({ ...VALID_BODY, requestedBy: "attacker@example.com" }));

    expect(response.status).toBe(200);
    expect(mocks.createMock).toHaveBeenCalledWith(expect.objectContaining({ requestedBy: "auditor-1" }));
  });

  // FR-13 / Acceptance Criterion 7: a row-count estimate above the sync
  // threshold creates a queued :ExportJob and returns 202 immediately
  // (before generation completes), then the background continuation
  // transitions it through running -> completed.
  it("async path (rowCount > threshold): returns 202 with a queued job BEFORE generation completes", async () => {
    mocks.countRegisterAsOfMock.mockResolvedValueOnce(3000);
    let resolveFindRegister: (value: unknown) => void = () => undefined;
    const pending = new Promise((resolve) => {
      resolveFindRegister = resolve;
    });
    mocks.findRegisterAsOfMock.mockReturnValueOnce(pending);

    const response = await POST(makeRequest(VALID_BODY));

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toEqual({ exportId: "exp-1", status: "queued" });
    // Generation has not completed yet — the response returned before the
    // background continuation's awaited findRegisterAsOf call resolved.
    expect(mocks.markCompletedMock).not.toHaveBeenCalled();

    resolveFindRegister([{ obligation: { obligation_id: "ob-1" } }]);
    await flushMicrotasks();

    expect(mocks.markRunningMock).toHaveBeenCalledWith("exp-1");
    expect(mocks.markCompletedMock).toHaveBeenCalledWith("exp-1", { rowCount: 1, filePath: "/tmp/exp-1.xlsx", fileSizeBytes: 11 });
  });

  it("marks the job failed (not left running) when background generation throws", async () => {
    mocks.countRegisterAsOfMock.mockResolvedValueOnce(3000);
    mocks.findRegisterAsOfMock.mockRejectedValueOnce(new Error("generation library crashed"));

    const response = await POST(makeRequest(VALID_BODY));
    expect(response.status).toBe(202);

    await flushMicrotasks();

    expect(mocks.markFailedMock).toHaveBeenCalledWith("exp-1", "generation library crashed");
  });

  // NFR-7: no more than AUDIT_EXPORT_MAX_CONCURRENT_JOBS (default 3)
  // export jobs run concurrently.
  it("429 TOO_MANY_CONCURRENT_EXPORTS when at the concurrency cap", async () => {
    mocks.countRegisterAsOfMock.mockResolvedValueOnce(3000);
    mocks.countActiveJobsMock.mockResolvedValueOnce(3);

    const response = await POST(makeRequest(VALID_BODY));

    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error).toBe("TOO_MANY_CONCURRENT_EXPORTS");
    expect(mocks.createMock).not.toHaveBeenCalled();
  });

  it("honors AUDIT_EXPORT_SYNC_ROW_THRESHOLD env override", async () => {
    process.env.AUDIT_EXPORT_SYNC_ROW_THRESHOLD = "5000";
    mocks.countRegisterAsOfMock.mockResolvedValueOnce(3000); // now under the raised threshold

    const response = await POST(makeRequest(VALID_BODY));

    expect(response.status).toBe(200);
    expect(mocks.findRegisterAsOfMock).toHaveBeenCalledTimes(1);
  });
});
