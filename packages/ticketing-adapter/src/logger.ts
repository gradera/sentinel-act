// Minimal structured logging helper (NFR-5), mirroring
// packages/audit-ledger/src/logger.ts's convention. Deliberately not a
// logging framework dependency — a hackathon-scoped package should not
// need one.
//
// NFR-5: "Every outbox row state transition MUST be logged as structured
// JSON: { outboxId, event_id, task_id, fromStatus, toStatus, attempts,
// durationMs }." logOutboxTransition below is the single call site every
// state-transition log line in this package funnels through.

export interface LogOperationInput {
  operation: string;
  entityType?: string | null;
  entityId?: string | null;
  outcome: "success" | "error";
  durationMs: number;
  detail?: Record<string, unknown>;
}

/** Logs one structured JSON line — `info` on success, `error` on
 *  failure. Never throws. */
export function logOperation(input: LogOperationInput): void {
  const entry = { ts: new Date().toISOString(), ...input };
  try {
    if (input.outcome === "error") {
      console.error(JSON.stringify({ ...entry, level: "error" }));
      return;
    }
    console.log(JSON.stringify({ ...entry, level: "info" }));
  } catch {
    // Logging must never break a write path.
  }
}

export interface OutboxTransitionLogInput {
  outboxId: string;
  event_id: string;
  task_id: string;
  fromStatus: string;
  toStatus: string;
  attempts: number;
  durationMs: number;
}

/** NFR-5's exact structured-log shape for every outbox row state
 *  transition. Never throws. */
export function logOutboxTransition(input: OutboxTransitionLogInput): void {
  try {
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", operation: "outbox_transition", ...input }));
  } catch {
    // Logging must never break a write path.
  }
}
