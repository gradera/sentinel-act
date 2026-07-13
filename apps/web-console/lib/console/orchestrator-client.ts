// Thin BFF -> Orchestrator client wrappers (Spec 09 §5.2): getReviewGate,
// getReviewGateBatch, getRunRef, claimSlot, submitDecision. Each mints a
// service JWT (service-jwt.ts) and calls apps/orchestrator's real HTTP
// surface (apps/orchestrator/src/server/http-server.ts) with it.
//
// ---------------------------------------------------------------------------
// UPDATED (spec-09-stage-2): the transport this file's previous revision
// flagged as missing now exists — apps/orchestrator/src/server/http-server.ts
// is a real, listening `node:http` server exposing:
//
//   GET  /api/orchestrator/obligations/:obligationId/review-gate
//   POST /api/orchestrator/obligations/review-gate/batch   (new, this stage)
//   GET  /api/orchestrator/obligations/:obligationId/run-ref (new, this stage)
//   POST /api/orchestrator/obligations/:obligationId/claim
//   POST /api/orchestrator/obligations/:obligationId/resume
//
// against `process.env.ORCHESTRATOR_BASE_URL` (both apps' .env.example
// files already define this). Every function below is now a real `fetch`
// call, not a stub — apps/orchestrator is STILL not an in-process import
// (no `main`/`types`/`exports` in its package.json, see git history on
// this file for the fuller writeup of that finding) but that no longer
// matters: HTTP was always the intended long-term transport (Spec 09
// §5.2's "two independently deployed processes, REST over tRPC" framing),
// and it is what this file now uses.
// ---------------------------------------------------------------------------

import { mintServiceJwt, toAuthorizationHeader } from "./service-jwt";
import type { ReviewGateView } from "./types";

/** Thrown when `ORCHESTRATOR_BASE_URL` is not configured — fails closed,
 *  same posture as `mintServiceJwt`'s missing-secret case, rather than
 *  silently calling a relative/undefined URL. */
export class OrchestratorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrchestratorConfigError";
  }
}

/** Network failure (connection refused, DNS, timeout) or a response body
 *  that isn't valid JSON where JSON was expected. Distinct from
 *  `OrchestratorResponseError` (a well-formed non-2xx response) because
 *  callers (route handlers) generally want to treat this case as "the
 *  Orchestrator is unreachable" (Spec 09 §8's degraded-read / 502 rows),
 *  not as a specific domain error to map to a 4xx. */
export class OrchestratorUnavailableError extends Error {
  constructor(operation: string, cause: unknown) {
    super(
      `orchestrator-client.${operation}: request to the Orchestrator failed (network error or malformed response body).`,
      { cause }
    );
    this.name = "OrchestratorUnavailableError";
  }
}

/** A well-formed non-2xx JSON response from the Orchestrator, e.g.
 *  `{ error: "SUSPENDED_STEP_NOT_FOUND", message: "..." }`. `code` is the
 *  `error` field verbatim (or `"UNKNOWN_ERROR"` if the body didn't have
 *  one) — route handlers switch on this to build their own Spec 09 §8
 *  error-mapping response, they do not need to re-parse `status` alone. */
export class OrchestratorResponseError extends Error {
  constructor(
    public readonly operation: string,
    public readonly status: number,
    public readonly code: string,
    message?: string
  ) {
    super(message ?? `orchestrator-client.${operation}: Orchestrator responded ${status} ${code}`);
    this.name = "OrchestratorResponseError";
  }
}

function getOrchestratorBaseUrl(): string {
  const base = process.env.ORCHESTRATOR_BASE_URL;
  if (!base) {
    throw new OrchestratorConfigError("ORCHESTRATOR_BASE_URL is not configured — cannot call the Orchestrator.");
  }
  return base.replace(/\/+$/, "");
}

interface OrchestratorFetchResult {
  status: number;
  body: unknown;
}

/** Single low-level `fetch` wrapper every function below routes through —
 *  one place to get network-error/JSON-parse-error handling right, so
 *  each exported function only has to deal with status-code branching. */
async function orchestratorFetch(operation: string, path: string, init: RequestInit): Promise<OrchestratorFetchResult> {
  let res: Response;
  try {
    res = await fetch(`${getOrchestratorBaseUrl()}${path}`, init);
  } catch (err) {
    if (err instanceof OrchestratorConfigError) {
      throw err;
    }
    throw new OrchestratorUnavailableError(operation, err);
  }

  const text = await res.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch (err) {
      throw new OrchestratorUnavailableError(operation, err);
    }
  }
  return { status: res.status, body };
}

function errorCodeFromBody(body: unknown): string {
  if (typeof body === "object" && body !== null && "error" in body && typeof (body as { error: unknown }).error === "string") {
    return (body as { error: string }).error;
  }
  return "UNKNOWN_ERROR";
}

function errorMessageFromBody(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null && "message" in body && typeof (body as { message: unknown }).message === "string") {
    return (body as { message: string }).message;
  }
  return undefined;
}

function throwForErrorStatus(operation: string, status: number, body: unknown): never {
  throw new OrchestratorResponseError(operation, status, errorCodeFromBody(body), errorMessageFromBody(body));
}

// ---------------------------------------------------------------------------
// GET .../review-gate — mirrors http-server.ts's handleReviewGate, which
// returns the WIRE `ReviewGateView` (types.ts, kind-discriminated union),
// not the orchestrator's internal 4-value-status shape.
// ---------------------------------------------------------------------------

export interface GetReviewGateInput {
  obligationId: string;
  reviewerId: string;
  tier: "B" | "C" | "ESCALATE";
}

export async function getReviewGate(input: GetReviewGateInput): Promise<ReviewGateView> {
  const authorization = toAuthorizationHeader(mintServiceJwt());
  const query = new URLSearchParams({ reviewerId: input.reviewerId, tier: input.tier });
  const { status, body } = await orchestratorFetch(
    "getReviewGate",
    `/api/orchestrator/obligations/${encodeURIComponent(input.obligationId)}/review-gate?${query.toString()}`,
    { method: "GET", headers: { authorization } }
  );
  if (status !== 200) {
    throwForErrorStatus("getReviewGate", status, body);
  }
  return body as ReviewGateView;
}

// ---------------------------------------------------------------------------
// POST .../review-gate/batch — Spec 09 §11 Task 2 / §13's batched
// review-gate endpoint, added to apps/orchestrator this stage
// (http-server.ts's handleReviewGateBatch) specifically so
// `GET /api/console/queue` does not issue N sequential Orchestrator calls
// per page (NFR-Perf-1). One HTTP round-trip in, one out; the loop happens
// server-side inside apps/orchestrator.
// ---------------------------------------------------------------------------

export interface GetReviewGateBatchInput {
  reviewerId: string;
  items: Array<{ obligationId: string; tier: "B" | "C" | "ESCALATE" }>;
}

export interface ReviewGateBatchEntry {
  obligationId: string;
  view: ReviewGateView;
}

export async function getReviewGateBatch(input: GetReviewGateBatchInput): Promise<ReviewGateBatchEntry[]> {
  const authorization = toAuthorizationHeader(mintServiceJwt());
  if (input.items.length === 0) {
    // Skip the round-trip entirely for an empty page — nothing to batch,
    // and http-server.ts's handler would just echo back `{ results: [] }`.
    return [];
  }
  const { status, body } = await orchestratorFetch("getReviewGateBatch", "/api/orchestrator/obligations/review-gate/batch", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ reviewerId: input.reviewerId, items: input.items })
  });
  if (status !== 200) {
    throwForErrorStatus("getReviewGateBatch", status, body);
  }
  const results = (body as { results?: ReviewGateBatchEntry[] } | null)?.results;
  return Array.isArray(results) ? results : [];
}

// ---------------------------------------------------------------------------
// GET .../run-ref — new this stage (http-server.ts's handleRunRef), backed
// by the Orchestrator's in-process SuspendedRunIndexPort.find. Needed
// because `POST .../resume` requires `runId`/`stepId`, which nothing in
// apps/web-console previously had a way to resolve — see this app's
// route-handler doc comments (items/[obligationId]/decisions/route.ts) for
// how it's used.
// ---------------------------------------------------------------------------

export interface RunRef {
  runId: string;
  stepId: "awaitHumanReview" | "awaitSecondHumanReview";
}

/** Returns `null` when the obligation has no suspended run recorded (not
 *  awaiting human review at all, or already resumed/cleared) — this is a
 *  normal, expected outcome (e.g. a stale page after Tier A auto-commit),
 *  not an error; callers map it to their own 409/404 semantics. */
export async function getRunRef(obligationId: string): Promise<RunRef | null> {
  const authorization = toAuthorizationHeader(mintServiceJwt());
  const { status, body } = await orchestratorFetch(
    "getRunRef",
    `/api/orchestrator/obligations/${encodeURIComponent(obligationId)}/run-ref`,
    { method: "GET", headers: { authorization } }
  );
  if (status !== 200) {
    throwForErrorStatus("getRunRef", status, body);
  }
  return (body as RunRef | null) ?? null;
}

// ---------------------------------------------------------------------------
// POST .../claim — mirrors http-server.ts's handleClaim.
// ---------------------------------------------------------------------------

export interface ClaimSlotInput {
  obligationId: string;
  reviewerId: string;
}

export interface ClaimSlotResult {
  status: 200 | 409;
  slot?: "maker" | "checker";
}

export async function claimSlot(input: ClaimSlotInput): Promise<ClaimSlotResult> {
  const authorization = toAuthorizationHeader(mintServiceJwt());
  const { status, body } = await orchestratorFetch(
    "claimSlot",
    `/api/orchestrator/obligations/${encodeURIComponent(input.obligationId)}/claim`,
    {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ reviewerId: input.reviewerId })
    }
  );
  if (status === 200) {
    const slot = (body as { slot?: "maker" | "checker" } | null)?.slot;
    return { status: 200, slot };
  }
  if (status === 409) {
    // http-server.ts's handleClaim always sends `{ error: "SLOT_UNAVAILABLE" }`
    // for 409 (it does not distinguish "you already hold a slot" from
    // "both slots taken by others" — see that file's own doc comment).
    return { status: 409 };
  }
  throwForErrorStatus("claimSlot", status, body);
}

// ---------------------------------------------------------------------------
// POST .../resume — mirrors http-server.ts's handleResume /
// resumeOrchestratorRun's real signature. Named `submitDecision` here (not
// `resume`) to match this app's routing vocabulary; it wraps the same real
// Orchestrator endpoint. `runId`/`stepId` must be resolved by the caller
// first (via `getRunRef` above) — this function only builds and sends the
// flat wire body `parseResumeBody` (http-server.ts) expects.
//
// `review`'s field names (`event_id`, `obligation_id`, `reviewer_id`,
// `tier`, `decision`, `rationale`, `decided_at`, `source`, `source_ref`)
// are verified exact against `parseResumeBody`.
// ---------------------------------------------------------------------------

export interface HumanReviewSubmittedEventInput {
  event_id: string;
  obligation_id: string;
  reviewer_id: string;
  tier: "B" | "C"; // "A" is rejected by recordHumanReview (FR-19) — never construct this for Tier A
  decision: "approve" | "reject";
  rationale: string | null;
  decided_at: string;
  source: "web-console" | "slack";
  source_ref: string | null;
}

export interface SubmitDecisionInput {
  runId: string;
  stepId: "awaitHumanReview" | "awaitSecondHumanReview";
  obligation_id: string;
  review: HumanReviewSubmittedEventInput;
}

export type ObligationStatusLike = string; // avoids a second import cycle here; callers narrow to ObligationStatus

export interface SubmitDecisionResult {
  resumed: boolean;
  finalStatus: ObligationStatusLike | "still_pending";
}

export async function submitDecision(input: SubmitDecisionInput): Promise<SubmitDecisionResult> {
  const authorization = toAuthorizationHeader(mintServiceJwt());
  const payload = {
    runId: input.runId,
    stepId: input.stepId,
    obligation_id: input.obligation_id,
    event_id: input.review.event_id,
    reviewer_id: input.review.reviewer_id,
    tier: input.review.tier,
    decision: input.review.decision,
    rationale: input.review.rationale,
    decided_at: input.review.decided_at,
    source: input.review.source,
    source_ref: input.review.source_ref
  };
  const { status, body } = await orchestratorFetch(
    "submitDecision",
    `/api/orchestrator/obligations/${encodeURIComponent(input.obligation_id)}/resume`,
    {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(payload)
    }
  );
  if (status !== 200) {
    throwForErrorStatus("submitDecision", status, body);
  }
  return body as SubmitDecisionResult;
}
