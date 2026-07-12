// Minimal structured logging helper (NFR-5). Every write path (`create`,
// `supersede`, `commitProposal`) calls logOperation once per call so the
// Observability Console's read-only "replay a step" feature (a later
// spec) has something to correlate against. Deliberately not a logging
// framework dependency — a hackathon-scoped package should not need one.

export interface LogOperationInput {
  operation: string;
  label?: string;
  proposalId?: string;
  durationMs: number;
  outcome: "success" | "error";
  detail?: Record<string, unknown>;
}

const SLOW_QUERY_THRESHOLD_MS = 200;

/** Logs one structured JSON line to stdout (success/error at `info`) or
 *  stderr (`warn`, only when durationMs exceeds the slow-query
 *  threshold). Never throws. */
export function logOperation(input: LogOperationInput): void {
  const entry = {
    ts: new Date().toISOString(),
    ...input
  };
  try {
    if (input.durationMs > SLOW_QUERY_THRESHOLD_MS) {
      console.warn(JSON.stringify({ ...entry, level: "warn" }));
      return;
    }
    console.log(JSON.stringify({ ...entry, level: "info" }));
  } catch {
    // Logging must never break a write path.
  }
}
