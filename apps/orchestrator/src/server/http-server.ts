// Spec 08 §6 FR-24a: the HTTP surface backing the pure functions in
// orchestrator.workflow.ts. Hand-rolled on Node's built-in `node:http` only
// — no framework dependency (Hono is present transitively via Mastra's own
// dev server but is not a declared/resolvable dependency of this package;
// see the module-level note in start.ts). Six routes:
//
//   GET  /api/orchestrator/obligations/:obligationId/review-gate
//   POST /api/orchestrator/obligations/review-gate/batch
//   GET  /api/orchestrator/obligations/:obligationId/run-ref
//   POST /api/orchestrator/obligations/:obligationId/claim
//   POST /api/orchestrator/obligations/:obligationId/resume
//   GET  /healthz
//
// Server-to-server only (Spec 09's BFF, Spec 11's Slack backend) — never
// called from a browser. Auth is `SENTINEL_SERVICE_JWT_SECRET` via
// `assertServiceAuth`, already implemented in orchestrator.workflow.ts.
//
// Two additions on top of the original four routes (Spec 09 stage-2 gaps,
// both added in the same hand-rolled style as the rest of this file, no
// new framework/dependency):
//
//   GET  /api/orchestrator/obligations/:obligationId/run-ref
//     Spec 09's BFF needs `{runId, stepId}` to build a `POST .../resume`
//     body, but nothing outside this process previously exposed
//     `SuspendedRunIndexPort.find` (the in-memory index is the only thing
//     that knows this pairing). Read-only, mirrors the existing routes'
//     auth/error pattern; backed by `deps.index.find`.
//
//   POST /api/orchestrator/obligations/review-gate/batch
//     Spec 09 §11 Task 2 / §13's "Batched review-gate endpoint" note: the
//     queue screen needs review-gate state for N obligations per page
//     without N sequential round-trips from the BFF (NFR-Perf-1). This is
//     the "thin wrapper that loops server-side" variant §13 explicitly
//     calls an acceptable default — still exactly one HTTP round-trip from
//     the BFF's perspective, no new dependency, same auth/error shape as
//     the single-item route it wraps (`handleReviewGateRequest` +
//     `index.getClaimSlots`, per obligation, in a loop).
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import {
  assertServiceAuth,
  getOrchestratorRuntime,
  handleClaimRequest,
  handleReviewGateRequest,
  resumeOrchestratorRun
} from "../mastra/workflows/orchestrator.workflow.js";
import type { ClaimRequest, ReviewGateRequest } from "../mastra/workflows/orchestrator.workflow.js";
import {
  NotAssignedError,
  OrchestratorError,
  ResumeValidationError,
  ReviewerIndependenceError,
  ServiceAuthError
} from "../mastra/workflows/orchestrator.errors.js";
import { toWireReviewGateView } from "../mastra/workflows/orchestrator.review-gate-view.js";
import type { HumanReviewSubmissionEvent } from "../mastra/workflows/orchestrator.types.js";

// ---------------------------------------------------------------------------
// Small local error type for hand-written request validation (400s). Kept
// distinct from OrchestratorError's typed hierarchy since it is a
// transport-layer concern, not a domain error.
// ---------------------------------------------------------------------------

class BadRequestError extends Error {}

// ---------------------------------------------------------------------------
// Low-level helpers.
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer | string) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function parseJsonBody(raw: string): unknown {
  if (!raw || raw.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new BadRequestError("request body must be valid JSON.");
  }
}

function getHeaderAsString(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

/** Maps every typed error this HTTP layer can see to a documented JSON
 *  error body. Unknown errors never leak internals — 500 with a generic
 *  code, message logged server-side only. */
function handleError(res: ServerResponse, err: unknown): void {
  if (err instanceof ServiceAuthError) {
    sendJson(res, 401, { error: "UNAUTHORIZED", message: err.message });
    return;
  }
  if (err instanceof BadRequestError) {
    sendJson(res, 400, { error: "INVALID_REQUEST", message: err.message });
    return;
  }
  if (err instanceof ResumeValidationError) {
    // Spec 09 §5.2's resume contract: a stale/mismatched runId|stepId|
    // obligation_id, or a run that isn't actually suspended awaiting this
    // reviewer, is reported as 409 SUSPENDED_STEP_NOT_FOUND.
    sendJson(res, 409, { error: "SUSPENDED_STEP_NOT_FOUND", message: err.message });
    return;
  }
  if (err instanceof ReviewerIndependenceError) {
    // Spec 09 §5.2's resume 403 set includes SELF_REVIEW_FORBIDDEN, the
    // closest documented code for "checker === maker" (FR-25).
    sendJson(res, 403, { error: "SELF_REVIEW_FORBIDDEN", message: err.message });
    return;
  }
  if (err instanceof NotAssignedError) {
    // FR-20/FR-31: the submitting reviewer does not hold the claimed
    // maker/checker slot for this dual-review step.
    sendJson(res, 403, { error: "NOT_ASSIGNED", message: err.message });
    return;
  }
  if (err instanceof OrchestratorError) {
    sendJson(res, 400, { error: "ORCHESTRATOR_ERROR", message: err.message });
    return;
  }
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      operation: "orchestrator-http-server",
      message: err instanceof Error ? err.message : String(err)
    })
  );
  sendJson(res, 500, { error: "INTERNAL_ERROR" });
}

// ---------------------------------------------------------------------------
// Route: GET /api/orchestrator/obligations/:obligationId/review-gate
// ---------------------------------------------------------------------------

const REVIEW_GATE_TIERS: ReadonlySet<"B" | "C" | "ESCALATE"> = new Set(["B", "C", "ESCALATE"]);

async function handleReviewGate(req: IncomingMessage, res: ServerResponse, obligationId: string, url: URL): Promise<void> {
  try {
    const reviewerId = url.searchParams.get("reviewerId");
    const tierRaw = url.searchParams.get("tier");
    if (!reviewerId || reviewerId.trim().length === 0) {
      throw new BadRequestError("reviewerId query parameter is required.");
    }
    if (!tierRaw || !REVIEW_GATE_TIERS.has(tierRaw as "B" | "C" | "ESCALATE")) {
      throw new BadRequestError('tier query parameter must be one of "B", "C", "ESCALATE".');
    }
    const tier = tierRaw as "B" | "C" | "ESCALATE";
    const authorization = getHeaderAsString(req, "authorization");

    const reqShape: ReviewGateRequest = { obligationId, reviewerId, tier, authorization };
    // Note (documented choice, per Spec 09 §8's error table): there is no
    // dedicated "obligation exists / has a suspended run" check wired into
    // handleReviewGateRequest's available ports (getReviewsVisibleTo alone
    // cannot distinguish "unknown obligation" from "no reviews submitted
    // yet" — both return []). A 404 here would need a Neo4j existence
    // lookup this endpoint's current dependency surface does not have, so
    // an unknown obligationId currently resolves to the same view as a
    // legitimately pending one (harmless: the caller just sees "nothing to
    // review yet"). Malformed/missing query params -> 400; missing/invalid
    // auth -> 401 (both implemented below and in handleReviewGateRequest).
    const internalView = await handleReviewGateRequest(reqShape);
    const claimSlots = tier === "C" ? await getOrchestratorRuntime().index.getClaimSlots(obligationId) : null;
    const wireView = toWireReviewGateView(internalView, reviewerId, claimSlots);
    sendJson(res, 200, wireView);
  } catch (err) {
    handleError(res, err);
  }
}

// ---------------------------------------------------------------------------
// Route: GET /api/orchestrator/obligations/:obligationId/run-ref
// ---------------------------------------------------------------------------

async function handleRunRef(req: IncomingMessage, res: ServerResponse, obligationId: string): Promise<void> {
  try {
    const authorization = getHeaderAsString(req, "authorization");
    assertServiceAuth(authorization);
    const found = await getOrchestratorRuntime().index.find(obligationId);
    // 200 with a JSON `null` body (not 404) when there is no suspended run
    // for this obligation — mirrors handleReviewGate's own documented
    // choice not to distinguish "unknown obligation" from "nothing
    // suspended yet" at this layer; the BFF's route handler decides what
    // that means for its own 404/409 semantics.
    sendJson(res, 200, found);
  } catch (err) {
    handleError(res, err);
  }
}

// ---------------------------------------------------------------------------
// Route: POST /api/orchestrator/obligations/review-gate/batch
// ---------------------------------------------------------------------------

interface ReviewGateBatchItem {
  obligationId: string;
  tier: "B" | "C" | "ESCALATE";
}

function parseReviewGateBatchBody(raw: unknown): { reviewerId: string; items: ReviewGateBatchItem[] } {
  if (typeof raw !== "object" || raw === null) {
    throw new BadRequestError("request body must be a JSON object.");
  }
  const body = raw as Record<string, unknown>;
  const reviewerId = requireString(body.reviewerId, "reviewerId");
  if (!Array.isArray(body.items)) {
    throw new BadRequestError("items must be an array.");
  }
  const items = body.items.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new BadRequestError(`items[${index}] must be an object.`);
    }
    const entry = item as Record<string, unknown>;
    const obligationId = requireString(entry.obligationId, `items[${index}].obligationId`);
    const tier = requireEnum(entry.tier, REVIEW_GATE_TIERS, `items[${index}].tier`);
    return { obligationId, tier };
  });
  return { reviewerId, items };
}

async function handleReviewGateBatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const authorization = getHeaderAsString(req, "authorization");
    // Explicit pre-check (not just relying on handleReviewGateRequest's own
    // per-item assertServiceAuth call below) so an empty `items: []` batch
    // from an unauthenticated caller still 401s rather than silently
    // succeeding with `{ results: [] }`.
    assertServiceAuth(authorization);

    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    const { reviewerId, items } = parseReviewGateBatchBody(parsed);

    const results: Array<{ obligationId: string; view: ReturnType<typeof toWireReviewGateView> }> = [];
    for (const item of items) {
      const internalView = await handleReviewGateRequest({ obligationId: item.obligationId, reviewerId, tier: item.tier, authorization });
      const claimSlots = item.tier === "C" ? await getOrchestratorRuntime().index.getClaimSlots(item.obligationId) : null;
      results.push({ obligationId: item.obligationId, view: toWireReviewGateView(internalView, reviewerId, claimSlots) });
    }
    sendJson(res, 200, { results });
  } catch (err) {
    handleError(res, err);
  }
}

// ---------------------------------------------------------------------------
// Route: POST /api/orchestrator/obligations/:obligationId/claim
// ---------------------------------------------------------------------------

async function handleClaim(req: IncomingMessage, res: ServerResponse, obligationId: string): Promise<void> {
  try {
    const authorization = getHeaderAsString(req, "authorization");
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (typeof parsed !== "object" || parsed === null) {
      throw new BadRequestError("request body must be a JSON object.");
    }
    const reviewerIdRaw = (parsed as Record<string, unknown>).reviewerId;
    if (typeof reviewerIdRaw !== "string" || reviewerIdRaw.trim().length === 0) {
      throw new BadRequestError("reviewerId is required in the request body.");
    }

    const reqShape: ClaimRequest = { obligationId, reviewerId: reviewerIdRaw, authorization };
    const result = await handleClaimRequest(reqShape);
    if (result.status === 200) {
      sendJson(res, 200, { slot: result.slot });
    } else {
      // 409: neither slot was open. ALREADY_CLAIMED is used when a caller
      // is likely retrying after a previous claim; SLOT_UNAVAILABLE is the
      // general case (both slots taken by others). handleClaimRequest does
      // not currently distinguish "you already hold a slot" from "both
      // slots taken by others" — SLOT_UNAVAILABLE is deliberately chosen
      // as the single self-explanatory code covering both, since a later
      // BFF stage can re-fetch the review-gate view for detail if needed.
      sendJson(res, 409, { error: "SLOT_UNAVAILABLE" });
    }
  } catch (err) {
    handleError(res, err);
  }
}

// ---------------------------------------------------------------------------
// Route: POST /api/orchestrator/obligations/:obligationId/resume
// ---------------------------------------------------------------------------

const RESUME_STEP_IDS: ReadonlySet<"awaitHumanReview" | "awaitSecondHumanReview"> = new Set([
  "awaitHumanReview",
  "awaitSecondHumanReview"
]);
const REVIEW_TIERS: ReadonlySet<"A" | "B" | "C"> = new Set(["A", "B", "C"]);
const REVIEW_DECISIONS: ReadonlySet<"approve" | "reject"> = new Set(["approve", "reject"]);
const REVIEW_SOURCES: ReadonlySet<"web-console" | "slack"> = new Set(["web-console", "slack"]);

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BadRequestError(`${field} is required and must be a non-empty string.`);
  }
  return value;
}

function requireEnum<T extends string>(value: unknown, allowed: ReadonlySet<T>, field: string): T {
  if (typeof value !== "string" || !allowed.has(value as T)) {
    throw new BadRequestError(`${field} must be one of: ${Array.from(allowed).join(", ")}.`);
  }
  return value as T;
}

function optionalNullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new BadRequestError(`${field} must be a string or null.`);
  }
  return value;
}

/** Builds a `HumanReviewSubmissionEvent` (Spec 08 §4.3) from the resume
 *  endpoint's flat JSON body. The BFF (a later stage, not built here) is
 *  responsible for resolving `runId`/`stepId` before calling this endpoint
 *  — this function only validates and reshapes what it is given. Body
 *  shape: `{ runId, stepId, obligation_id, event_id, reviewer_id, tier,
 *  decision, rationale, decided_at, source, source_ref }` — a flat
 *  envelope + Spec 07's HumanReviewSubmittedEvent fields, not nested under
 *  a `review` key, to keep the wire body a single flat JSON object for
 *  callers. */
function parseResumeBody(raw: unknown, urlObligationId: string): HumanReviewSubmissionEvent {
  if (typeof raw !== "object" || raw === null) {
    throw new BadRequestError("request body must be a JSON object.");
  }
  const body = raw as Record<string, unknown>;

  const runId = requireString(body.runId, "runId");
  const stepId = requireEnum(body.stepId, RESUME_STEP_IDS, "stepId");
  const obligationId = requireString(body.obligation_id, "obligation_id");
  if (obligationId !== urlObligationId) {
    throw new BadRequestError(`obligation_id in body (${obligationId}) does not match the URL path (${urlObligationId}).`);
  }
  const eventId = requireString(body.event_id, "event_id");
  const reviewerId = requireString(body.reviewer_id, "reviewer_id");
  const tier = requireEnum(body.tier, REVIEW_TIERS, "tier");
  const decision = requireEnum(body.decision, REVIEW_DECISIONS, "decision");
  const rationale = optionalNullableString(body.rationale, "rationale");
  const decidedAt = requireString(body.decided_at, "decided_at");
  const source = requireEnum(body.source, REVIEW_SOURCES, "source");
  const sourceRef = optionalNullableString(body.source_ref, "source_ref");

  return {
    runId,
    stepId,
    obligation_id: obligationId,
    review: {
      event_id: eventId,
      obligation_id: obligationId,
      reviewer_id: reviewerId,
      tier,
      decision,
      rationale,
      decided_at: decidedAt,
      source,
      source_ref: sourceRef
    }
  };
}

async function handleResume(req: IncomingMessage, res: ServerResponse, obligationId: string): Promise<void> {
  try {
    const authorization = getHeaderAsString(req, "authorization");
    // resumeOrchestratorRun has no auth parameter of its own (Spec 08's
    // pure function is transport-agnostic) — this HTTP layer is
    // responsible for the auth gate, per the task brief.
    assertServiceAuth(authorization);

    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    const event = parseResumeBody(parsed, obligationId);

    const result = await resumeOrchestratorRun(event);
    sendJson(res, 200, result);
  } catch (err) {
    handleError(res, err);
  }
}

// ---------------------------------------------------------------------------
// Route: GET /healthz (Spec 15 §5.3 — web-console pings ORCHESTRATOR_BASE_URL
// + "/healthz", not "/readyz").
// ---------------------------------------------------------------------------

function handleHealthz(res: ServerResponse): void {
  sendJson(res, 200, { status: "ok", serviceAuthConfigured: Boolean(process.env.SENTINEL_SERVICE_JWT_SECRET) });
}

// ---------------------------------------------------------------------------
// Router + server factory.
// ---------------------------------------------------------------------------

const REVIEW_GATE_RE = /^\/api\/orchestrator\/obligations\/([^/]+)\/review-gate$/;
const REVIEW_GATE_BATCH_PATH = "/api/orchestrator/obligations/review-gate/batch";
const RUN_REF_RE = /^\/api\/orchestrator\/obligations\/([^/]+)\/run-ref$/;
const CLAIM_RE = /^\/api\/orchestrator\/obligations\/([^/]+)\/claim$/;
const RESUME_RE = /^\/api\/orchestrator\/obligations\/([^/]+)\/resume$/;

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://internal");
  const pathname = url.pathname;

  if (method === "GET" && pathname === "/healthz") {
    handleHealthz(res);
    return;
  }

  // Checked before the REVIEW_GATE_RE regex below: this is a fixed, literal
  // path with no obligationId segment, so it can never collide with
  // `/obligations/:obligationId/review-gate` (that regex only matches
  // paths ending exactly in `/review-gate`, which this one does not — it
  // ends in `/review-gate/batch`) — order does not actually matter for
  // correctness here, but checking the exact-match route first keeps the
  // dispatcher's intent obvious.
  if (method === "POST" && pathname === REVIEW_GATE_BATCH_PATH) {
    await handleReviewGateBatch(req, res);
    return;
  }

  const reviewGateMatch = REVIEW_GATE_RE.exec(pathname);
  if (method === "GET" && reviewGateMatch) {
    await handleReviewGate(req, res, decodeURIComponent(reviewGateMatch[1]), url);
    return;
  }

  const runRefMatch = RUN_REF_RE.exec(pathname);
  if (method === "GET" && runRefMatch) {
    await handleRunRef(req, res, decodeURIComponent(runRefMatch[1]));
    return;
  }

  const claimMatch = CLAIM_RE.exec(pathname);
  if (method === "POST" && claimMatch) {
    await handleClaim(req, res, decodeURIComponent(claimMatch[1]));
    return;
  }

  const resumeMatch = RESUME_RE.exec(pathname);
  if (method === "POST" && resumeMatch) {
    await handleResume(req, res, decodeURIComponent(resumeMatch[1]));
    return;
  }

  sendJson(res, 404, { error: "NOT_FOUND" });
}

/** Creates the FR-24a HTTP server. Caller is responsible for calling
 *  `configureOrchestratorRuntime(...)` (orchestrator.workflow.ts) before
 *  the server starts handling traffic — every route ultimately reads
 *  `getOrchestratorRuntime()`. */
export function createHttpServer(): Server {
  return createServer((req, res) => {
    dispatch(req, res).catch((err) => {
      handleError(res, err);
    });
  });
}
