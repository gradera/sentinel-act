// Small shared helpers for apps/web-console/app/api/console/**/route.ts
// handlers — mapping this app's typed errors (session.ts, orchestrator-client.ts,
// review-gate-adapter.ts) to the JSON error bodies Spec 09 §5.1/§8 document,
// so each route handler's own try/catch stays short and every route uses
// the same JSON error shape (`{ error: string; message?: string }`).
import { NextResponse } from "next/server";
import { ForbiddenError, UnauthorizedError } from "./session";

export function jsonError(status: number, error: string, message?: string): NextResponse {
  return NextResponse.json(message ? { error, message } : { error }, { status });
}

/** Maps `getReviewerSession`/`requireSession`/`requireRole`'s typed errors
 *  to a response. Every route handler in this app calls this FIRST in its
 *  catch block, before any route-specific error mapping — session/role
 *  failures are identical across all four routes. Returns `null` when
 *  `err` is not a session error, so callers can chain their own mapping:
 *  `return mapSessionError(err) ?? mapOrchestratorError(err) ?? fallback;` */
export function mapSessionError(err: unknown): NextResponse | null {
  if (err instanceof UnauthorizedError) {
    return jsonError(401, "UNAUTHORIZED", err.message);
  }
  if (err instanceof ForbiddenError) {
    return jsonError(403, err.code, err.message);
  }
  return null;
}
