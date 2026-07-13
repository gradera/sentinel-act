// Spec 10 §13 Open Question 2 — "Generated file storage: local/ephemeral
// disk vs. object storage." Recommendation followed verbatim for this
// hackathon build: write to a local `tmp/exports/`-style directory,
// `ExportJobStore` records the path (§4.2's `filePath` field doc comment:
// "server-local path or object-store key").
//
// ***** Path choice, and why it is NOT `<repo>/tmp/exports` *****
// There is no existing repo-wide `tmp/`/scratch-directory convention
// anywhere else in this monorepo (checked before writing this file) for
// this module to follow. Two candidates were considered:
//   1. `path.join(process.cwd(), "tmp", "exports")` — but `process.cwd()`
//      for a Next.js route handler is only reliably "the app's own
//      directory" under `next dev`/`next start` run from
//      apps/web-console; this file's own test suite (vitest, invoked from
//      the MONOREPO ROOT per this app's vitest.config.ts) would instead
//      create a `tmp/exports` directory at the repo root — polluting the
//      checked-out working tree with generated PDFs/XLSX from every test
//      run, which is exactly the kind of stray build artifact a repo
//      should never accumulate.
//   2. `os.tmpdir()` + a namespaced subfolder — OS-appropriate scratch
//      space (`/tmp` on Linux/macOS, `%TEMP%` on Windows) that is
//      guaranteed to exist and writable, identical behavior whether this
//      code runs under `next dev`, `next start`, or a test runner
//      invoked from any cwd. Chosen for exactly that cwd-independence.
//
// ***** Must-fix-before-production flag (repeated from §13) *****
// Local disk (of either flavor above) is NOT shared across multiple
// server instances and is NOT guaranteed to persist across a serverless
// function's cold start/instance recycling. Before any multi-instance or
// serverless deployment of apps/web-console, this module's two functions
// below must be re-implemented against an object store (S3-compatible
// bucket or equivalent), with `ComplianceRegisterExportJob.filePath`
// becoming an object key rather than a filesystem path — `ExportJobStore`
// itself is already storage-agnostic (it just persists whatever string
// `filePath` it's given), so only THIS file's two functions would need to
// change, not the job-bookkeeping layer.
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExportFormat } from "@sentinel-act/graph-db";

const EXPORTS_DIR = path.join(os.tmpdir(), "sentinel-act-exports");

/** Writes a generated export Buffer to local disk under `EXPORTS_DIR`,
 *  named `<exportId>.<format>` (stable, collision-free — `exportId` is a
 *  uuid v4 per `ExportJobStore.create`'s own doc comment). Returns the
 *  absolute path and byte size, both of which the caller persists onto
 *  the `:ExportJob` node via `ExportJobStore.markCompleted`. */
export async function writeExportFile(exportId: string, format: ExportFormat, buffer: Buffer): Promise<{ filePath: string; fileSizeBytes: number }> {
  await mkdir(EXPORTS_DIR, { recursive: true });
  const filePath = path.join(EXPORTS_DIR, `${exportId}.${format}`);
  await writeFile(filePath, buffer);
  return { filePath, fileSizeBytes: buffer.length };
}

/** Reads a previously-written export file back off local disk — backs
 *  `GET /api/audit/export/:exportId/download`. Throws (ENOENT) if the
 *  file is missing, e.g. a job's `:ExportJob` node survived past a
 *  cleanup task that already deleted the file but somehow didn't reach
 *  this node yet — the route handler's own `expiresAt` time-based check
 *  (§8's "download requested for an expired export" row) is the primary
 *  defense against serving a should-be-gone file; this is a defensive
 *  backstop, not the primary check. */
export async function readExportFile(filePath: string): Promise<Buffer> {
  return readFile(filePath);
}

/** Deletes a previously-written export file from local disk — backs the
 *  FR-16 scheduled cleanup task (`scripts/cleanup-expired-exports.ts`),
 *  which calls this once per `filePath` returned by
 *  `ExportJobStore.deleteExpired()`. Tolerates `ENOENT` (the file is
 *  already gone — e.g. a job whose file was already cleaned up by a prior
 *  run, or a `queued`/`failed` job that never had a file to begin with,
 *  though the caller filters `null` paths out before ever reaching this
 *  function) so a cleanup run is safely re-runnable / idempotent. Every
 *  other error (e.g. `EACCES`) propagates so a real permissions problem
 *  is not silently swallowed. */
export async function deleteExportFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      throw error;
    }
  }
}
