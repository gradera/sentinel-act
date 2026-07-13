// Spec 10 §5.5 `GET /api/audit/export/:exportId/download` — streams the
// generated file back once `status === "completed"`. Read-only against
// the Regulatory Knowledge Graph (FR-21): the only graph call is
// `ExportJobStore.find`; the file itself is read from local disk via
// `readExportFile` (lib/console/export-storage.ts — see that file's
// top-of-file comment for the local-disk-vs-object-storage tradeoff this
// hackathon build accepts).
//
// ***** Status-code choices, documented (§8 doesn't pin every one
// ***** verbatim) *****
//   - `status !== "completed"` (queued/running) -> 409, matching §8's own
//     literal example row: '409 { error: "export not ready", status }'.
//   - `status === "failed"` -> 500, matching §8's literal example row:
//     '500 { error } if status === "failed"'.
//   - past `expiresAt` -> 410, matching §8's literal
//     '410 { error: "export expired" }' row — checked BEFORE the
//     completed/file-read branch, and time-based (compares `now` to
//     `expiresAt`) rather than existence-based, per that row's own
//     rationale: "even if the file happens to not yet be physically
//     deleted by the cleanup task ... a slow cleanup run never
//     accidentally serves a file that should be considered gone."
//
// ***** Ownership decision — same as the sibling status route *****
// Any authenticated Observer-mode caller may download ANY completed
// export job's file, not just ones they requested — see
// `export/[exportId]/route.ts`'s doc comment for the full reasoning
// (kept in one place rather than duplicated verbatim in both files).
import { NextResponse, type NextRequest } from "next/server";
import { ExportJobStore, getDriver } from "@sentinel-act/graph-db";
import { mapAuditQueryError } from "@/lib/console/audit-errors";
import { readExportFile } from "@/lib/console/export-storage";
import { jsonError, mapSessionError } from "@/lib/console/route-errors";
import { getReviewerSession, OBSERVER_MODE_ROLES, requireRole, requireSession } from "@/lib/console/session";

const CONTENT_TYPES: Record<"pdf" | "xlsx", string> = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};

export async function GET(request: NextRequest, context: { params: Promise<{ exportId: string }> }): Promise<NextResponse> {
  try {
    const session = requireSession(await getReviewerSession(request));
    requireRole(session, OBSERVER_MODE_ROLES);

    const { exportId } = await context.params;

    const store = new ExportJobStore(getDriver());
    const job = await store.find(exportId);
    if (!job) {
      return jsonError(404, "NOT_FOUND", `export job ${exportId} was not found.`);
    }

    if (new Date(job.expiresAt).getTime() <= Date.now()) {
      return jsonError(410, "EXPORT_EXPIRED", "export expired");
    }

    if (job.status === "failed") {
      return jsonError(500, "EXPORT_FAILED", job.errorMessage ?? "export generation failed.");
    }

    if (job.status !== "completed" || !job.filePath) {
      return jsonError(409, "EXPORT_NOT_READY", "export not ready");
    }

    const buffer = await readExportFile(job.filePath);
    const fileName = `compliance-register-${job.asOfDate}.${job.format}`;

    // NextResponse's BodyInit typing doesn't include Node's `Buffer`
    // directly (even though Buffer IS a Uint8Array at runtime) — a plain
    // Uint8Array view over the same bytes satisfies both the type checker
    // and the runtime response body.
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": CONTENT_TYPES[job.format],
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Length": String(buffer.length)
      }
    });
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
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        operation: "GET /api/audit/export/:exportId/download",
        message: err instanceof Error ? err.message : String(err)
      })
    );
    return jsonError(500, "INTERNAL_ERROR");
  }
}
