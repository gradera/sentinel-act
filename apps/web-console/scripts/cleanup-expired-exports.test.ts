// Spec 10 FR-16 — unit test for the cleanup script's orchestration logic
// (`cleanupExpiredExports`). This is the reasonably-testable slice of
// FR-16: it exercises the "call deleteExpired, then delete every non-null
// filePath, tolerate/report per-file failures without aborting the run"
// logic against a fake `ExportJobStore`/fake file-deleter, with zero real
// Neo4j connection and zero real disk I/O.
//
// ***** What this test deliberately does NOT prove *****
// It does not prove `ExportJobStore.deleteExpired`'s own Cypher is correct
// (that's `packages/graph-db/test/queries/export-job-store.test.ts`'s job,
// already covered there) and it does not prove a real file at a real
// `os.tmpdir()` path is actually removed from disk by `deleteExportFile`
// (that would require real filesystem I/O in a test, which is better
// verified manually/in a real environment — see this file's sibling
// `cleanup-expired-exports.ts`'s own header comment for the manual
// verification already performed: a real `unlink()` against
// `os.tmpdir()/sentinel-act-exports/...` was confirmed to succeed in this
// sandbox, distinct from the mounted-repo EPERM restriction). Wiring this
// script to a real scheduler (cron/Vercel Cron/k8s CronJob) is also not
// testable here — it's a deployment-target decision, explicitly deferred
// per §13 Open Question 9 (see the script's header comment).
import { describe, expect, it, vi } from "vitest";
import { cleanupExpiredExports } from "./cleanup-expired-exports.js";

describe("cleanupExpiredExports", () => {
  // FR-16: deletes every file path ExportJobStore.deleteExpired() returns.
  it("deletes every non-null filePath returned by ExportJobStore.deleteExpired via the injected file-deleter", async () => {
    const store = {
      deleteExpired: vi.fn().mockResolvedValue({
        deletedCount: 3,
        filePaths: ["/tmp/sentinel-act-exports/a.pdf", "/tmp/sentinel-act-exports/b.xlsx", null]
      })
    };
    const deleteFile = vi.fn().mockResolvedValue(undefined);

    const result = await cleanupExpiredExports(store, deleteFile);

    expect(store.deleteExpired).toHaveBeenCalledTimes(1);
    expect(deleteFile).toHaveBeenCalledTimes(2);
    expect(deleteFile).toHaveBeenCalledWith("/tmp/sentinel-act-exports/a.pdf");
    expect(deleteFile).toHaveBeenCalledWith("/tmp/sentinel-act-exports/b.xlsx");
    expect(result).toEqual({ deletedJobs: 3, deletedFiles: 2, fileDeleteErrors: 0 });
  });

  // FR-16 edge case: an expired job that never completed (queued/failed)
  // has filePath: null (ComplianceRegisterExportJob doc comment: "set once
  // generation completes") — must be skipped, never passed to the deleter.
  it("skips null filePaths (an expired job that never completed) without calling the file-deleter", async () => {
    const store = {
      deleteExpired: vi.fn().mockResolvedValue({ deletedCount: 1, filePaths: [null] })
    };
    const deleteFile = vi.fn().mockResolvedValue(undefined);

    const result = await cleanupExpiredExports(store, deleteFile);

    expect(deleteFile).not.toHaveBeenCalled();
    expect(result).toEqual({ deletedJobs: 1, deletedFiles: 0, fileDeleteErrors: 0 });
  });

  // A single file's deletion failing (e.g. a real EACCES, since ENOENT is
  // already tolerated inside deleteExportFile itself, not here) must not
  // abort the whole run — every other file still gets attempted, and the
  // failure is reported via fileDeleteErrors rather than thrown.
  it("continues past a single file-deletion failure and reports it in fileDeleteErrors rather than throwing", async () => {
    const store = {
      deleteExpired: vi.fn().mockResolvedValue({
        deletedCount: 2,
        filePaths: ["/tmp/sentinel-act-exports/good.pdf", "/tmp/sentinel-act-exports/bad.pdf"]
      })
    };
    const deleteFile = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("EACCES: permission denied"));

    const result = await cleanupExpiredExports(store, deleteFile);

    expect(deleteFile).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ deletedJobs: 2, deletedFiles: 1, fileDeleteErrors: 1 });
  });

  // No expired jobs at all — the common case on most scheduled runs.
  it("is a no-op returning all-zero counts when deleteExpired finds nothing expired", async () => {
    const store = {
      deleteExpired: vi.fn().mockResolvedValue({ deletedCount: 0, filePaths: [] })
    };
    const deleteFile = vi.fn();

    const result = await cleanupExpiredExports(store, deleteFile);

    expect(deleteFile).not.toHaveBeenCalled();
    expect(result).toEqual({ deletedJobs: 0, deletedFiles: 0, fileDeleteErrors: 0 });
  });
});
