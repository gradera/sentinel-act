"use client";

import * as React from "react";
import type { AuditQueryFilters, ComplianceRegisterExportJob, ExportFormat } from "@sentinel-act/graph-db";
import { auditFetch } from "@/lib/console/audit-fetch";

const POLL_INTERVAL_MS = 2000;

type JobState = ComplianceRegisterExportJob | { exportId: string; status: "queued" };

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed";
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * ExportPanel — Compliance Register Export (§4.2/§5.5, FR-11..FR-19).
 * As-of date + format toggle, filter carry-over from the current search
 * (only `tier` overlaps between `AuditQueryFilters` and
 * `ComplianceRegisterExportRequest.filters` — `obligationCategory`/
 * `intermediaryCategoryName` have no equivalent on the search screen, so
 * there is nothing to carry over for those), then `POST /api/audit/export`
 * and poll `GET /api/audit/export/:exportId` until terminal.
 *
 * FR-19 interpretation: FR-19's exact text is "the export panel help text"
 * must state that the export "includes Tier A auto-committed items; the
 * search table above does not, since Tier A has no human review to
 * search for" — implemented verbatim below, not paraphrased, since the
 * spec gives the literal copy to use. This is a *different* distinction
 * from "as of date vs. current state" (that one is FR-11, also called out
 * separately below) — both are real, separate FR-19/FR-11 requirements,
 * not the same help text doing double duty.
 */
export function ExportPanel({ filters }: { filters: AuditQueryFilters }) {
  const [asOfDate, setAsOfDate] = React.useState<string>(todayIsoDate);
  const [format, setFormat] = React.useState<ExportFormat>("xlsx");
  const [job, setJob] = React.useState<JobState | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (!job || isTerminal(job.status)) {
      return;
    }
    const timer = setInterval(() => {
      void (async () => {
        try {
          const res = await auditFetch(`/api/audit/export/${job.exportId}`);
          if (res.ok) {
            setJob((await res.json()) as ComplianceRegisterExportJob);
          }
        } catch {
          // Transient network error — next tick retries; not fatal.
        }
      })();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [job]);

  async function generate() {
    setError(null);
    setJob(null);
    setSubmitting(true);
    try {
      const body: { asOfDate: string; format: ExportFormat; filters?: { tier: AuditQueryFilters["tier"] } } = { asOfDate, format };
      if (filters.tier) {
        body.filters = { tier: filters.tier };
      }
      const res = await auditFetch("/api/audit/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const parsed = await res.json().catch(() => null);
      if (!res.ok) {
        setError((parsed && typeof parsed.error === "string" ? parsed.error : null) ?? `Unable to start export (${res.status}).`);
        return;
      }
      setJob(parsed as JobState);
    } catch {
      setError("Network error — export was not started, please retry.");
    } finally {
      setSubmitting(false);
    }
  }

  const canGenerate = !submitting && (!job || isTerminal(job.status));
  const downloadHref = job && "filePath" in job && job.filePath ? `/api/audit/export/${job.exportId}/download` : null;

  return (
    <div className="space-y-3 rounded-lg border border-dashed border-muted-foreground/40 bg-card p-4 text-sm">
      <h2 className="text-sm font-semibold">Compliance Register Export</h2>

      {/* FR-11: "as of" is a required, explicit point-in-time parameter,
          never a silent "current state" default. */}
      <p className="text-xs text-muted-foreground">
        A point-in-time snapshot as of the date you choose below — there is no "export current state" mode. If you
        want today's state, choose today's date explicitly.
      </p>
      {/* FR-19, verbatim per the spec's own help-text requirement. */}
      <p className="text-xs text-muted-foreground">
        Includes Tier A auto-committed items; the search table above does not, since Tier A has no human review to
        search for.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="export-as-of" className="text-xs font-medium text-muted-foreground">
            As-of date
          </label>
          <input
            id="export-as-of"
            type="date"
            value={asOfDate}
            onChange={(e) => setAsOfDate(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          />
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Format</span>
          <div className="flex gap-1">
            {(["xlsx", "pdf"] satisfies ExportFormat[]).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFormat(f)}
                aria-pressed={format === f}
                className={
                  format === f
                    ? "h-9 rounded-md border border-input bg-secondary px-3 text-xs font-medium text-secondary-foreground"
                    : "h-9 rounded-md border border-input bg-background px-3 text-xs font-medium text-muted-foreground"
                }
              >
                {f.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        {/* No primary-color CTA on this screen — bordered/secondary, not
            the operator queue's <Button variant="default"> treatment. */}
        <button
          type="button"
          onClick={() => void generate()}
          disabled={!canGenerate}
          className="h-9 rounded-md border border-input bg-secondary px-4 text-sm font-medium text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50"
        >
          {submitting ? "Starting…" : "Generate export"}
        </button>
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      {job ? (
        <p className="text-xs text-muted-foreground">
          Status: {job.status}
          {"rowCount" in job && job.rowCount !== null ? ` · ${job.rowCount} rows` : null}
          {"errorMessage" in job && job.errorMessage ? ` · ${job.errorMessage}` : null}
        </p>
      ) : null}

      {downloadHref ? (
        <a href={downloadHref} className="inline-block text-xs font-medium text-foreground underline">
          Download {format.toUpperCase()}
        </a>
      ) : null}
    </div>
  );
}
