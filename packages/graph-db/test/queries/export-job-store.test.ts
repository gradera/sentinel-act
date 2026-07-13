// export-job-store.test.ts (Spec 10 §5.4/§10) — mocked neo4j-driver
// session/transaction, matching audit-query.test.ts's established
// mocking convention for this package.
//
// ***** Honesty note (same caveat as audit-query.test.ts) *****
// A mocked-driver unit test proves the Cypher string/params ExportJobStore
// sends to `session.run` are well-formed (e.g. deleteExpired's WHERE
// clause correctly compares against a cutoff, countActiveJobs' filter
// includes the right status values) — it cannot prove Neo4j actually
// evaluates that Cypher the way we expect against real data, since the
// mock driver never evaluates Cypher semantics, only records what was
// passed to `.run()` and returns whatever canned records the test
// supplies. A real `export-job-lifecycle.integration.test.ts` (referenced
// in the spec's §9 test plan) against a live Neo4j 5.13+ container is
// still required before this unit is genuinely done per the spec's
// Definition of Done — flagged here explicitly, not skipped silently.
import { describe, expect, it } from "vitest";
import { ExportJobStore } from "../../src/queries/export-job-store.js";
import { NotFoundError } from "../../src/errors.js";
import { createMockDriver, mockRecord } from "../helpers/mock-driver.js";

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const baseExportJobProps = {
  exportId: "exp-1",
  status: "queued",
  requestedAt: "2026-07-01T00:00:00Z",
  requestedBy: "auditor@example.com",
  asOfDate: "2026-07-01",
  format: "pdf",
  filtersJson: null,
  rowCount: null,
  filePath: null,
  fileSizeBytes: null,
  errorMessage: null,
  completedAt: null,
  expiresAt: "2026-07-08T00:00:00Z"
};

function exportJobRecord(overrides: Record<string, unknown> = {}) {
  return mockRecord({ j: { properties: { ...baseExportJobProps, ...overrides } } });
}

describe("ExportJobStore.create", () => {
  // FR-16: expiresAt = requestedAt + 7d default retention window.
  it("writes a :ExportJob node with status queued, a generated uuid v4 exportId, and the 7-day retention window, via executeWrite", async () => {
    const { driver, calls, executeWriteCallCount } = createMockDriver(() => ({
      records: [exportJobRecord()]
    }));
    const store = new ExportJobStore(driver);

    const job = await store.create({
      asOfDate: "2026-07-01",
      format: "pdf",
      requestedBy: "auditor@example.com"
    });

    expect(executeWriteCallCount()).toBe(1);
    expect(calls).toHaveLength(1);
    const call = calls[0];

    expect(call.cypher).toContain("CREATE (j:ExportJob)");
    expect(call.cypher).toContain('j.status = "queued"');
    expect(call.cypher).toContain("j.requestedAt = datetime()");
    expect(call.cypher).toContain("j.expiresAt = datetime() + duration({days: $retentionDays})");

    expect(call.params.requestedBy).toBe("auditor@example.com");
    expect(call.params.asOfDate).toBe("2026-07-01");
    expect(call.params.format).toBe("pdf");
    expect(call.params.filtersJson).toBeNull();
    expect(call.params.retentionDays).toBe(7);
    expect(call.params.exportId).toMatch(UUID_V4_RE);

    expect(job.status).toBe("queued");
    expect(job.exportId).toBe("exp-1");
  });

  it("JSON-serializes the filters object into filtersJson (Neo4j properties can't hold nested maps)", async () => {
    const { driver, calls } = createMockDriver(() => ({ records: [exportJobRecord()] }));
    const store = new ExportJobStore(driver);

    await store.create({
      asOfDate: "2026-07-01",
      format: "xlsx",
      requestedBy: "auditor@example.com",
      filters: { obligationCategory: "disclosure", tier: "C" }
    });

    expect(calls[0].params.filtersJson).toBe(JSON.stringify({ obligationCategory: "disclosure", tier: "C" }));
  });

  it("round-trips filters back into an object on read", async () => {
    const filters = { intermediaryCategoryName: "Stockbroker" };
    const { driver } = createMockDriver(() => ({
      records: [exportJobRecord({ filtersJson: JSON.stringify(filters) })]
    }));
    const store = new ExportJobStore(driver);

    const job = await store.create({ asOfDate: "2026-07-01", format: "pdf", requestedBy: "a", filters });

    expect(job.filters).toEqual(filters);
  });
});

describe("ExportJobStore.find", () => {
  it("returns null (not an error) when no job matches, via executeRead", async () => {
    const { driver, calls, executeWriteCallCount } = createMockDriver(() => ({ records: [] }));
    const store = new ExportJobStore(driver);

    const result = await store.find("does-not-exist");

    expect(result).toBeNull();
    expect(calls[0].cypher).toContain("MATCH (j:ExportJob {exportId: $exportId})");
    expect(calls[0].params).toEqual({ exportId: "does-not-exist" });
    expect(executeWriteCallCount()).toBe(0);
  });

  it("returns the full job, backfilling absent nullable fields to null", async () => {
    const { driver } = createMockDriver(() => ({
      records: [
        mockRecord({
          j: {
            properties: {
              exportId: "exp-2",
              status: "queued",
              requestedAt: "2026-07-01T00:00:00Z",
              requestedBy: "auditor@example.com",
              asOfDate: "2026-07-01",
              format: "pdf",
              expiresAt: "2026-07-08T00:00:00Z"
              // filtersJson, rowCount, filePath, fileSizeBytes, errorMessage,
              // completedAt all deliberately absent (never set by Neo4j
              // when written as null — see serialize.ts).
            }
          }
        })
      ]
    }));
    const store = new ExportJobStore(driver);

    const job = await store.find("exp-2");

    expect(job).not.toBeNull();
    expect(job?.exportId).toBe("exp-2");
    expect(job?.filters).toBeUndefined();
    expect(job?.rowCount).toBeNull();
    expect(job?.filePath).toBeNull();
    expect(job?.fileSizeBytes).toBeNull();
    expect(job?.errorMessage).toBeNull();
    expect(job?.completedAt).toBeNull();
  });
});

describe("ExportJobStore.countActiveJobs", () => {
  it("counts only queued/running jobs, via executeRead, and does not read any env var itself", async () => {
    const { driver, calls, executeWriteCallCount } = createMockDriver(() => ({
      records: [mockRecord({ total: 2 })]
    }));
    const store = new ExportJobStore(driver);

    const count = await store.countActiveJobs();

    expect(count).toBe(2);
    expect(calls[0].cypher).toContain('WHERE j.status IN ["queued", "running"]');
    expect(executeWriteCallCount()).toBe(0);
  });

  it("unwraps a neo4j Integer-like total (toNumber())", async () => {
    const { driver } = createMockDriver(() => ({
      records: [mockRecord({ total: { toNumber: () => 3 } })]
    }));
    const store = new ExportJobStore(driver);

    const count = await store.countActiveJobs();

    expect(count).toBe(3);
  });
});

describe("ExportJobStore.markRunning", () => {
  it("transitions status to running via executeWrite", async () => {
    const { driver, calls, executeWriteCallCount } = createMockDriver(() => ({
      records: [exportJobRecord({ status: "running" })]
    }));
    const store = new ExportJobStore(driver);

    await store.markRunning("exp-1");

    expect(executeWriteCallCount()).toBe(1);
    expect(calls[0].cypher).toContain("MATCH (j:ExportJob {exportId: $exportId})");
    expect(calls[0].cypher).toContain('SET j.status = "running"');
    expect(calls[0].params).toEqual({ exportId: "exp-1" });
  });

  it("throws NotFoundError when exportId does not exist", async () => {
    const { driver } = createMockDriver(() => ({ records: [] }));
    const store = new ExportJobStore(driver);

    await expect(store.markRunning("missing")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("ExportJobStore.markCompleted", () => {
  it("sets status/rowCount/filePath/fileSizeBytes/completedAt via executeWrite", async () => {
    const { driver, calls, executeWriteCallCount } = createMockDriver(() => ({
      records: [exportJobRecord({ status: "completed", rowCount: 42, filePath: "/tmp/exports/exp-1.pdf", fileSizeBytes: 1024 })]
    }));
    const store = new ExportJobStore(driver);

    await store.markCompleted("exp-1", { rowCount: 42, filePath: "/tmp/exports/exp-1.pdf", fileSizeBytes: 1024 });

    expect(executeWriteCallCount()).toBe(1);
    expect(calls[0].cypher).toContain('SET j.status = "completed"');
    expect(calls[0].cypher).toContain("j.completedAt = datetime()");
    expect(calls[0].params).toEqual({
      exportId: "exp-1",
      rowCount: 42,
      filePath: "/tmp/exports/exp-1.pdf",
      fileSizeBytes: 1024
    });
  });

  it("throws NotFoundError when exportId does not exist", async () => {
    const { driver } = createMockDriver(() => ({ records: [] }));
    const store = new ExportJobStore(driver);

    await expect(store.markCompleted("missing", { rowCount: 1, filePath: "x", fileSizeBytes: 1 })).rejects.toBeInstanceOf(
      NotFoundError
    );
  });
});

describe("ExportJobStore.markFailed", () => {
  it("sets status/errorMessage/completedAt via executeWrite", async () => {
    const { driver, calls, executeWriteCallCount } = createMockDriver(() => ({
      records: [exportJobRecord({ status: "failed", errorMessage: "boom" })]
    }));
    const store = new ExportJobStore(driver);

    await store.markFailed("exp-1", "boom");

    expect(executeWriteCallCount()).toBe(1);
    expect(calls[0].cypher).toContain('SET j.status = "failed"');
    expect(calls[0].cypher).toContain("j.errorMessage = $errorMessage");
    expect(calls[0].cypher).toContain("j.completedAt = datetime()");
    expect(calls[0].params).toEqual({ exportId: "exp-1", errorMessage: "boom" });
  });

  it("throws NotFoundError when exportId does not exist", async () => {
    const { driver } = createMockDriver(() => ({ records: [] }));
    const store = new ExportJobStore(driver);

    await expect(store.markFailed("missing", "boom")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("ExportJobStore.deleteExpired", () => {
  // FR-16: deleteExpired only removes jobs where now > expiresAt.
  it("uses the DB's own datetime() as the cutoff when `now` is omitted, via executeWrite", async () => {
    const { driver, calls, executeWriteCallCount } = createMockDriver(() => ({ records: [] }));
    const store = new ExportJobStore(driver);

    const result = await store.deleteExpired();

    expect(executeWriteCallCount()).toBe(1);
    expect(calls[0].cypher).toContain("WHERE j.expiresAt <= datetime()");
    expect(calls[0].cypher).not.toContain("datetime($now)");
    expect(calls[0].params).toEqual({});
    expect(result).toEqual({ deletedCount: 0, filePaths: [] });
  });

  it("compares against an explicit forced `now` cutoff when provided, wired as a literal parameter", async () => {
    const { driver, calls } = createMockDriver(() => ({ records: [] }));
    const store = new ExportJobStore(driver);

    await store.deleteExpired("2026-07-20T00:00:00Z");

    expect(calls[0].cypher).toContain("WHERE j.expiresAt <= datetime($now)");
    expect(calls[0].params).toEqual({ now: "2026-07-20T00:00:00Z" });
  });

  // FR-16: deleteExpired returns filePaths so the caller (the cleanup
  // script, scripts/cleanup-expired-exports.ts) can delete the actual
  // generated files, not just the :ExportJob bookkeeping nodes.
  it("deletes only the matched (expired) nodes and returns their file paths for the caller to clean up", async () => {
    const { driver } = createMockDriver(() => ({
      records: [mockRecord({ filePath: "/tmp/exports/exp-old-1.pdf" }), mockRecord({ filePath: null })]
    }));
    const store = new ExportJobStore(driver);

    const result = await store.deleteExpired("2026-07-20T00:00:00Z");

    expect(result.deletedCount).toBe(2);
    expect(result.filePaths).toEqual(["/tmp/exports/exp-old-1.pdf", null]);
  });
});

describe("ExportJobStore — the read/write invariant (load-bearing for the later ESLint no-restricted-imports stage)", () => {
  it("find and countActiveJobs never call executeWrite", async () => {
    const { driver, executeWriteCallCount } = createMockDriver((cypher) =>
      cypher.includes("count(j)") ? { records: [mockRecord({ total: 0 })] } : { records: [] }
    );
    const store = new ExportJobStore(driver);

    await store.find("exp-1");
    await store.countActiveJobs();

    expect(executeWriteCallCount()).toBe(0);
  });

  it("markRunning, markCompleted, markFailed, and deleteExpired each call executeWrite exactly once", async () => {
    const { driver, executeWriteCallCount } = createMockDriver(() => ({ records: [exportJobRecord()] }));
    const store = new ExportJobStore(driver);

    await store.markRunning("exp-1");
    expect(executeWriteCallCount()).toBe(1);

    await store.markCompleted("exp-1", { rowCount: 1, filePath: "x", fileSizeBytes: 1 });
    expect(executeWriteCallCount()).toBe(2);

    await store.markFailed("exp-1", "boom");
    expect(executeWriteCallCount()).toBe(3);

    await store.deleteExpired();
    expect(executeWriteCallCount()).toBe(4);
  });
});
