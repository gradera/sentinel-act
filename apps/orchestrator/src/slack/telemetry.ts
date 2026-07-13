// Spec 11 §4/FR-24(b) — emits ReviewSubmissionTelemetryEvent to the
// ops/telemetry stream, SEPARATE from the HumanReviewSubmittedEvent graph
// write (Fix 1: this type never touches recordHumanReview, never appears
// in any auditor-facing read — see packages/review-contracts/src/events.ts's
// doc comment and FR-25).
//
// No telemetry backend exists in this build (out of scope — "ops
// dashboards" per the type's own doc comment); this module's default sink
// is a structured JSON log line at info level, matching the
// NFR-Observability-1 log shape convention every other unit in this repo
// uses (logOperation in monitoring-and-audit.agent.ts,
// packages/audit-ledger's logger.ts). Swappable via the `sink` param for
// a future real telemetry pipeline without changing call sites.
import { randomUUID } from "node:crypto";
import type { ReviewSubmissionTelemetryEvent, ReviewWorkflowState } from "@sentinel-act/review-contracts";

export type TelemetrySink = (event: ReviewSubmissionTelemetryEvent) => void | Promise<void>;

export const defaultTelemetrySink: TelemetrySink = (event) => {
  try {
    // NFR-Observability-1 shape, tagged distinctly from audit/ledger logs
    // so on-call can filter this stream separately — this line is
    // operational only, never read back into any auditor-facing surface.
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", operation: "reviewSubmissionTelemetry", event }));
  } catch {
    // Telemetry emission must never break the caller's success path.
  }
};

export interface EmitReviewSubmissionTelemetryInput {
  obligationId: string;
  reviewerId: string;
  tier: "B" | "C";
  decision: "approve" | "reject";
  workflowState: ReviewWorkflowState;
  latencyMs: number;
  submittedVia: "console" | "slack";
  emittedAt?: string;
  eventId?: string;
}

export async function emitReviewSubmissionTelemetry(input: EmitReviewSubmissionTelemetryInput, sink: TelemetrySink = defaultTelemetrySink): Promise<ReviewSubmissionTelemetryEvent> {
  const event: ReviewSubmissionTelemetryEvent = {
    eventId: input.eventId ?? randomUUID(),
    obligationId: input.obligationId,
    reviewerId: input.reviewerId,
    tier: input.tier,
    decision: input.decision,
    workflowState: input.workflowState,
    latencyMs: input.latencyMs,
    emittedAt: input.emittedAt ?? new Date().toISOString(),
    submittedVia: input.submittedVia
  };
  await sink(event);
  return event;
}
