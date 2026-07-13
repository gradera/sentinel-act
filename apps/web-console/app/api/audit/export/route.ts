// Spec 10 §5.5 `POST /api/audit/export` — Compliance Register Export,
// FR-11..FR-13/FR-17/FR-18's sync-vs-async row-count-threshold routing.
//
// Read-only against the Regulatory Knowledge Graph (FR-21): the only
// graph calls this file makes are `AuditQueryService.countRegisterAsOf` /
// `.findRegisterAsOf` (both `session.executeRead`) and `ExportJobStore`'s
// own create/markRunning/markCompleted/markFailed/countActiveJobs
// methods — `ExportJobStore`'s writes are the one documented, intentional
// exception to this unit's read-only rule (its own top-of-file comment:
// an `:ExportJob` node is operational bookkeeping, not a Regulatory
// Knowledge Graph fact). No import of GraphWriter/commitProposal/any
// repository create()/supersede() method anywhere in this file.
//
// ***** HONEST LIMITATION — read before treating the async path as real
// ***** background-job infrastructure *****
//
// FR-13 says an over-threshold export is generated "asynchronously" while
// the client polls `GET /api/audit/export/:exportId`. This Next.js app
// has NO durable background-job infrastructure — no queue, no worker
// process, no persistent task runner. `runExportJobInBackground` below is
// a plain fire-and-forget async function call (`void
// runExportJobInBackground(...)`), NOT awaited by the POST handler. This
// genuinely works correctly for the async contract (the job really does
// transition queued -> running -> completed/failed on its own, and a
// client polling the status route really does see it happen) as long as
// this Node process stays alive for the duration — true under `next dev`
// and under a persistent Node server deployment (`next start` on a
// long-running instance). It would NOT survive a serverless function's
// request/response boundary: most serverless runtimes (Vercel functions,
// AWS Lambda, etc.) freeze or tear down the execution environment once
// the HTTP response is sent, killing any in-flight `void` promise before
// it finishes. This is flagged, not silently pretended away — a genuine
// production deployment on a serverless target needs a real queue/worker
// (SQS+Lambda, a Vercel Background Function, a separate always-on worker
// process, etc.) before this path can be trusted at scale. See
// docs/specs/10-web-console-observer-mode-export.md §13 Open Question 8
// for the companion flag on the (also unbenchmarked) threshold/
// concurrency-cap numbers themselves.
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { AuditQueryService, ExportJobStore, getDriver } from "@sentinel-act/graph-db";
import type { ComplianceRegisterExportJob, ComplianceRegisterExportRequest, ExportFormat } from "@sentinel-act/graph-db";
import { generatePdf, generateXlsx, toRegisterRows } from "@sentinel-act/report-generation";
import type { PdfMetadata, XlsxMetadata } from "@sentinel-act/report-generation";
import { mapAuditQueryError } from "@/lib/console/audit-errors";
import { writeExportFile } from "@/lib/console/export-storage";
import { jsonError, mapSessionError } from "@/lib/console/route-errors";
import { getReviewerSession, OBSERVER_MODE_ROLES, requireRole, requireSession } from "@/lib/console/session";

// §13 Open Question 8: "make both configurable via environment variables
// (AUDIT_EXPORT_SYNC_ROW_THRESHOLD, AUDIT_EXPORT_MAX_CONCURRENT_JOBS)".
// Defaults match FR-12 (500 rows) / NFR-7 (3 concurrent jobs) exactly.
const DEFAULT_SYNC_ROW_THRESHOLD = 500;
const DEFAULT_MAX_CONCURRENT_JOBS = 3;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isIsoDateLike(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

// §4.2's ComplianceRegisterExportRequest, minus `requestedBy` — FR-17:
// "MUST be derived from the caller's authenticated session identity ...
// never trusted from the request body even if the client supplies one."
// Not declaring `requestedBy` in this schema means zod strips it (its
// default behavior for an unrecognized key on a non-`.strict()` object)
// even if a client sends one — there is no code path below that reads
// `body.requestedBy` at all.
const exportRequestBodySchema = z.object({
  asOfDate: z.string().refine(isIsoDateLike, "asOfDate must be a valid ISO date"),
  format: z.enum(["pdf", "xlsx"]),
  filters: z
    .object({
      obligationCategory: z.string().trim().min(1).optional(),
      intermediaryCategoryName: z.string().trim().min(1).optional(),
      tier: z.enum(["A", "B", "C"]).optional()
    })
    .optional()
});

/** Builds the `PdfMetadata`/`XlsxMetadata` FR-18 requires (asOfDate,
 *  generatedAt, generatedBy, filters) — identical shape for both
 *  generators (packages/report-generation's own doc comment: "keep the
 *  two generators' public APIs symmetric"). */
function buildMetadata(request: ComplianceRegisterExportRequest, generatedAt: string): PdfMetadata | XlsxMetadata {
  return { asOfDate: request.asOfDate, generatedAt, generatedBy: request.requestedBy, filters: request.filters };
}

/** Runs the §4.4 query, flattens it (to-register-rows.ts), generates the
 *  requested format's Buffer, and writes it to local disk. Shared by both
 *  the sync path (called inline, awaited) and the async path (called from
 *  `runExportJobInBackground`, NOT awaited by the request handler). */
async function generateRegisterFile(
  auditQueryService: AuditQueryService,
  exportId: string,
  request: ComplianceRegisterExportRequest
): Promise<{ rowCount: number; filePath: string; fileSizeBytes: number }> {
  const registerRows = await auditQueryService.findRegisterAsOf({
    asOfDate: request.asOfDate,
    category: request.filters?.obligationCategory,
    intermediaryCategoryName: request.filters?.intermediaryCategoryName,
    tier: request.filters?.tier
  });
  const rows = toRegisterRows(registerRows);
  const metadata = buildMetadata(request, new Date().toISOString());
  const buffer: Buffer = request.format === "xlsx" ? generateXlsx(rows, metadata) : generatePdf(rows, metadata);
  const { filePath, fileSizeBytes } = await writeExportFile(exportId, request.format, buffer);
  return { rowCount: rows.length, filePath, fileSizeBytes };
}

/** FR-13's fire-and-forget async continuation — see this file's
 *  top-of-file "HONEST LIMITATION" comment. Never throws (all errors are
 *  caught and turned into `ExportJobStore.markFailed`, matching §8's
 *  "Report generation library failure ... job marked failed with a
 *  generic errorMessage ... never left in running indefinitely" row) —
 *  safe to call as `void runExportJobInBackground(...)` without an
 *  unhandled-rejection risk. */
async function runExportJobInBackground(
  auditQueryService: AuditQueryService,
  exportJobStore: ExportJobStore,
  exportId: string,
  request: ComplianceRegisterExportRequest
): Promise<void> {
  try {
    await exportJobStore.markRunning(exportId);
    const result = await generateRegisterFile(auditQueryService, exportId, request);
    await exportJobStore.markCompleted(exportId, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "export generation failed";
    console.error(
      JSON.stringify({ ts: new Date().toISOString(), level: "error", operation: "runExportJobInBackground", exportId, message })
    );
    try {
      await exportJobStore.markFailed(exportId, message);
    } catch (markErr) {
      // §8: never left in "running" indefinitely is the goal; if even
      // markFailed fails (e.g. the graph itself is down), there is
      // nothing more this background task can do — logged, not thrown
      // (nothing is awaiting this promise to catch it).
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          operation: "runExportJobInBackground.markFailed",
          exportId,
          message: markErr instanceof Error ? markErr.message : String(markErr)
        })
      );
    }
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const session = requireSession(await getReviewerSession(request));
    requireRole(session, OBSERVER_MODE_ROLES);

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ error: "request body must be valid JSON.", field: "body" }, { status: 400 });
    }
    const parsed = exportRequestBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return NextResponse.json({ error: issue.message, field: issue.path.join(".") || "unknown" }, { status: 400 });
    }

    // FR-17: requestedBy is ALWAYS the session's own reviewerId — the
    // parsed body has no `requestedBy` field to even accidentally read.
    const exportRequest: ComplianceRegisterExportRequest = {
      asOfDate: parsed.data.asOfDate,
      format: parsed.data.format as ExportFormat,
      filters: parsed.data.filters,
      requestedBy: session.reviewerId
    };

    const driver = getDriver();
    const auditQueryService = new AuditQueryService(driver);
    const exportJobStore = new ExportJobStore(driver);

    // FR-12: cheap row-count estimate BEFORE generating anything.
    const rowCount = await auditQueryService.countRegisterAsOf({
      asOfDate: exportRequest.asOfDate,
      category: exportRequest.filters?.obligationCategory,
      intermediaryCategoryName: exportRequest.filters?.intermediaryCategoryName,
      tier: exportRequest.filters?.tier
    });

    const syncThreshold = readPositiveIntEnv("AUDIT_EXPORT_SYNC_ROW_THRESHOLD", DEFAULT_SYNC_ROW_THRESHOLD);
    const maxConcurrentJobs = readPositiveIntEnv("AUDIT_EXPORT_MAX_CONCURRENT_JOBS", DEFAULT_MAX_CONCURRENT_JOBS);

    if (rowCount <= syncThreshold) {
      // FR-12 fast path: generate inline, in this request, then persist
      // the job already in its terminal "completed" state so the client
      // can immediately hit the download route (no polling needed).
      const job = await exportJobStore.create(exportRequest);
      const result = await generateRegisterFile(auditQueryService, job.exportId, exportRequest);
      await exportJobStore.markCompleted(job.exportId, result);
      const completedJob = await exportJobStore.find(job.exportId);
      const responseJob: ComplianceRegisterExportJob = completedJob ?? {
        ...job,
        status: "completed",
        rowCount: result.rowCount,
        filePath: result.filePath,
        fileSizeBytes: result.fileSizeBytes,
        completedAt: new Date().toISOString()
      };
      return NextResponse.json(responseJob, { status: 200 });
    }

    // FR-13 async path: NFR-7's concurrency cap, checked before creating
    // the job (a rejected request should not consume a job/id at all).
    const activeJobs = await exportJobStore.countActiveJobs();
    if (activeJobs >= maxConcurrentJobs) {
      // §8 doesn't pin an exact status for this case; 429 is the more
      // correct HTTP semantic for "you are being rate-limited by a
      // concurrency cap, retry later" versus 503 ("the service itself is
      // down") — documented choice, not specified verbatim by the spec.
      return jsonError(429, "TOO_MANY_CONCURRENT_EXPORTS", `at most ${maxConcurrentJobs} export jobs may run concurrently; please retry shortly.`);
    }

    const job = await exportJobStore.create(exportRequest);
    // Fire-and-forget — see top-of-file "HONEST LIMITATION" comment.
    // Deliberately not awaited: the whole point of the async path is that
    // the HTTP response returns before generation finishes.
    void runExportJobInBackground(auditQueryService, exportJobStore, job.exportId, exportRequest);

    return NextResponse.json({ exportId: job.exportId, status: job.status }, { status: 202 });
  } catch (err) {
    const sessionResponse = mapSessionError(err);
    if (sessionResponse) {
      return sessionResponse;
    }
    const auditResponse = mapAuditQueryError(err);
    if (auditResponse) {
      return auditResponse;
    }
    console.error(
      JSON.stringify({ ts: new Date().toISOString(), level: "error", operation: "POST /api/audit/export", message: err instanceof Error ? err.message : String(err) })
    );
    return jsonError(500, "INTERNAL_ERROR");
  }
}
