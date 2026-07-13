// Minimal structured logging helper (NFR-3), mirroring
// packages/graph-db/src/logger.ts's convention. Deliberately not a
// logging framework dependency — a hackathon-scoped package should not
// need one.

export interface LogOperationInput {
  operation: string;
  entityType?: string | null;
  entityId?: string | null;
  outcome: "success" | "error";
  durationMs: number;
  detail?: Record<string, unknown>;
}

const SLOW_QUERY_THRESHOLD_MS = 200;

/** Logs one structured JSON line — `info` on success, `warn` on a slow
 *  success, `error` on failure. Never throws. */
export function logOperation(input: LogOperationInput): void {
  const entry = { ts: new Date().toISOString(), ...input };
  try {
    if (input.outcome === "error") {
      console.error(JSON.stringify({ ...entry, level: "error" }));
      return;
    }
    if (input.durationMs > SLOW_QUERY_THRESHOLD_MS) {
      console.warn(JSON.stringify({ ...entry, level: "warn" }));
      return;
    }
    console.log(JSON.stringify({ ...entry, level: "info" }));
  } catch {
    // Logging must never break a write path.
  }
}

/** FR-36: a failing `verifyChainIntegrity` run MUST emit a structured
 *  CRITICAL-level log through the application's normal observability
 *  path — distinct from `logOperation`'s "error" level, which is used
 *  for ordinary operational failures, not "the tamper-evidence chain is
 *  broken." Never throws. */
export function logCritical(operation: string, detail: Record<string, unknown>): void {
  try {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "CRITICAL", operation, ...detail }));
  } catch {
    // Logging must never break a write path.
  }
}
