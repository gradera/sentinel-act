// Spec 10 §8 error-handling table, shared by every `app/api/audit/**`
// route handler. Mirrors route-errors.ts's `mapSessionError` pattern
// exactly (try this mapper first in a route's catch block, chain with `??`
// into any route-specific mapping, fall back to 500) but for the
// `@sentinel-act/graph-db` error taxonomy this unit's routes can actually
// throw (`AuditQueryService`/`ExportJobStore` never throw a session/role
// error — those are session.ts's own `UnauthorizedError`/`ForbiddenError`,
// already handled by `mapSessionError`).
//
// Kept in its own file, separate from route-errors.ts, because
// route-errors.ts is Spec 09's Operator-mode file — Spec 09 has no
// GraphDbUnavailableError/ValidationError/timeout mapping of its own
// (Spec 09's routes talk to the Orchestrator, not directly to
// AuditQueryService), so adding this mapping there would mix two units'
// concerns in one file for no benefit.
import { NextResponse } from "next/server";
import { GraphDbUnavailableError, ValidationError } from "@sentinel-act/graph-db";
import { jsonError } from "./route-errors";

/** Duck-types neo4j-driver's own `Neo4jError` (has a string `.code`,
 *  e.g. "ServiceUnavailable", "SessionExpired", or a
 *  "Neo.TransientError.*" code) rather than importing neo4j-driver's
 *  error class directly — AuditQueryService/ExportJobStore both let a
 *  raw driver error propagate unwrapped on a connection failure (verified
 *  by reading both files in full: their catch blocks only log, then
 *  `throw error` unchanged), so this route layer is the first place such
 *  an error can be told apart from every other kind of thrown value. */
function isTransientDriverError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  if (typeof code !== "string") {
    return false;
  }
  return code.includes("ServiceUnavailable") || code.includes("SessionExpired") || code.includes("TransientError");
}

/** §8: "Timeout (a very broad, unfiltered query, or a huge export) ...
 *  AuditQueryService.search/findRegisterAsOf set an explicit Neo4j
 *  transaction timeout ... on timeout the route returns
 *  504 { error: "query timed out, narrow your filters" }". Neo4j's own
 *  transaction-timeout error carries a "Neo.ClientError.Transaction.
 *  TransactionTimedOut"-shaped `.code` and/or a message containing
 *  "timeout" (driver version dependent) — checked defensively on both. */
function isTransactionTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  const codeHasTimeout = typeof code === "string" && /timeout/i.test(code);
  return codeHasTimeout || /timed? ?out/i.test(err.message);
}

/** Maps AuditQueryService/ExportJobStore's thrown errors to the §8-shaped
 *  response. Returns `null` for anything it doesn't recognize so callers
 *  chain: `return mapSessionError(err) ?? mapAuditQueryError(err) ?? jsonError(500, "INTERNAL_ERROR");` */
export function mapAuditQueryError(err: unknown): NextResponse | null {
  if (err instanceof ValidationError) {
    return jsonError(400, "INVALID_FILTER", err.message);
  }
  if (isTransactionTimeoutError(err)) {
    return jsonError(504, "QUERY_TIMEOUT", "query timed out, narrow your filters.");
  }
  if (err instanceof GraphDbUnavailableError || isTransientDriverError(err)) {
    return jsonError(503, "GRAPH_DB_UNAVAILABLE", "search temporarily unavailable.");
  }
  return null;
}
