// Spec 11 §5.3 — this unit's bridge into Spec 08's proposed
// getReviewGate/claimReviewSlot/resumeReviewStep contract, called as
// direct IN-PROCESS function calls (this Slack gateway is mounted inside
// the same apps/orchestrator process as Spec 08's implementation, per
// §13's recommended default — no HTTP round-trip, no risk of drifting
// from the console's redaction/idempotency behavior).
//
// The three real functions this wraps — handleReviewGateRequest,
// handleClaimRequest, resumeOrchestratorRun — all live in
// orchestrator.workflow.ts and are exactly what Spec 09's BFF calls too
// (confirmed against apps/orchestrator/src/server/http-server.ts, which
// calls them the same way over HTTP). Two of the three
// (handleReviewGateRequest/handleClaimRequest) internally call
// assertServiceAuth(req.authorization) — a service-to-service JWT check
// against SENTINEL_SERVICE_JWT_SECRET — even for in-process callers, so
// this module mints its own short-lived HS256 JWT the same way
// apps/web-console/lib/console/service-jwt.ts does (that file cannot be
// imported here — apps/web-console is not a dependency of
// apps/orchestrator and importing "up" across apps is exactly the
// layering violation packages/review-contracts exists to avoid — so the
// ~10 lines of HS256 signing logic are ported, not shared; verification
// stays on the single source of truth, orchestrator.logic.ts's
// verifyServiceJwt). resumeOrchestratorRun has NO auth parameter at all
// (confirmed: HumanReviewSubmissionEvent carries no `authorization`
// field, and the function body never calls assertServiceAuth) — auth for
// the real POST .../resume HTTP route is enforced only by
// http-server.ts, so in-process callers of resumeOrchestratorRun get no
// gate to satisfy.
import { createHmac } from "node:crypto";
import type { ObligationStatus, ReviewTier } from "@sentinel-act/graph-schema";
import type { ReviewGateView } from "@sentinel-act/review-contracts";
import { ResumeReviewStepError, type ResumeReviewStepErrorCode } from "./resume-review-step-error.js";
import { buildHumanReviewSubmittedEvent } from "./human-review-event.js";

import {
  assertServiceAuth,
  getOrchestratorRuntime,
  handleClaimRequest,
  handleReviewGateRequest,
  resumeOrchestratorRun
} from "../mastra/workflows/orchestrator.workflow.js";
import { toWireReviewGateView } from "../mastra/workflows/orchestrator.review-gate-view.js";
import {
  NotAssignedError,
  ResumeValidationError,
  ReviewerIndependenceError,
  ServiceAuthError
} from "../mastra/workflows/orchestrator.errors.js";
import { ReviewAlreadyCompleteError, SameReviewerNotAllowedError, ValidationError } from "../mastra/agents/monitoring-and-audit.errors.js";
import type { ReviewWorkflowState } from "@sentinel-act/review-contracts";

// ---------------------------------------------------------------------------
// Service JWT minting (in-process caller only — see file header).
// ---------------------------------------------------------------------------

function base64UrlEncode(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Mints a fresh, short-lived HS256 JWT for satisfying
 *  handleReviewGateRequest/handleClaimRequest's internal assertServiceAuth
 *  check. Structurally identical to orchestrator.logic.ts's
 *  verifyServiceJwt (the single verification source of truth) and to
 *  apps/web-console/lib/console/service-jwt.ts's signServiceJwt (the
 *  console BFF's equivalent minter for the same purpose, over HTTP
 *  instead of in-process) — this is a deliberate, small, same-file-size
 *  duplication rather than a cross-app import. */
function mintServiceJwt(secret: string, ttlSeconds = 60): string {
  const header = base64UrlEncode({ alg: "HS256", typ: "JWT" });
  const payload = base64UrlEncode({ sub: "slack-gateway", exp: Math.floor(Date.now() / 1000) + ttlSeconds });
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function serviceAuthorizationHeader(): string {
  const secret = process.env.SENTINEL_SERVICE_JWT_SECRET;
  if (!secret) {
    throw new ServiceAuthError("SENTINEL_SERVICE_JWT_SECRET is not configured.");
  }
  return `Bearer ${mintServiceJwt(secret)}`;
}

// ---------------------------------------------------------------------------
// §5.3 getReviewGate — mirrors http-server.ts's handleReviewGate route
// handler's two-step call exactly (handleReviewGateRequest then
// toWireReviewGateView), so this unit cannot drift from what the console
// sees for the same (obligationId, reviewerId, tier).
// ---------------------------------------------------------------------------

export async function getReviewGate(
  obligationId: string,
  reviewerId: string,
  tier: "B" | "C" | "ESCALATE"
): Promise<ReviewGateView> {
  const authorization = serviceAuthorizationHeader();
  const internalView = await handleReviewGateRequest({ obligationId, reviewerId, tier, authorization });
  const claimSlots = tier === "C" ? await getOrchestratorRuntime().index.getClaimSlots(obligationId) : null;
  return toWireReviewGateView(internalView, reviewerId, claimSlots) as ReviewGateView;
}

/** Pure read of raw claim-slot occupancy (maker/checker Slack-side
 *  reviewerIds), used only to derive `SlackCardModel.otherSlotFilled`
 *  (FR-9's "a slot is no longer open" rendering) — never used to derive
 *  or leak decision/rationale content, which stays exclusively behind
 *  getReviewGate's redaction. */
export async function getClaimSlots(obligationId: string): Promise<{ maker: string | null; checker: string | null } | null> {
  return getOrchestratorRuntime().index.getClaimSlots(obligationId);
}

// ---------------------------------------------------------------------------
// §5.3 claimReviewSlot
// ---------------------------------------------------------------------------

export type ClaimReviewSlotResult =
  | { ok: true; viewerSlot: "maker" | "checker" }
  | { ok: false; code: "SLOT_UNAVAILABLE" };

export async function claimReviewSlot(obligationId: string, reviewerId: string): Promise<ClaimReviewSlotResult> {
  const authorization = serviceAuthorizationHeader();
  const result = await handleClaimRequest({ obligationId, reviewerId, authorization });
  if (result.status === 200 && result.slot) {
    return { ok: true, viewerSlot: result.slot };
  }
  return { ok: false, code: "SLOT_UNAVAILABLE" };
}

// ---------------------------------------------------------------------------
// §5.3 resumeReviewStep
//
// DEVIATION FROM THE LITERAL §5.3 SIGNATURE (documented): the spec's
// proposed return shape is
// `{ obligationStatus, humanReview, workflowState, reviewGate }`. The
// real `resumeOrchestratorRun` (Spec 08's actual, already-landed
// implementation, which this unit must not modify) only returns
// `{ resumed, finalStatus }` — it does not hand back the freshly-written
// HumanReview node (that node is created inside Spec 07's
// recordHumanReview, called internally by resumeOrchestratorRun; no
// caller-visible return path for it exists without either duplicating
// that write — a real independence/idempotency hazard, see FR-21a — or
// modifying orchestrator.workflow.ts, out of scope for this unit's edit
// boundary). This function therefore returns
// `{ obligationStatus, workflowState, reviewGate }` (no `humanReview`
// field) and callers render the post-decision confirmation from
// `reviewGate` (Tier B: `existingDecision`; Tier C once resolved:
// `reveal`) plus the decision/rationale the caller already knows it just
// submitted, not from a returned graph node.
// ---------------------------------------------------------------------------

export interface ResumeReviewStepResult {
  obligationStatus: ObligationStatus | "still_pending";
  workflowState: ReviewWorkflowState;
  reviewGate: ReviewGateView;
}

// Extracted to resume-review-step-error.ts (see that file's header
// comment for why) and re-exported here so existing call sites that
// import these two names FROM this module keep working unchanged.
export { ResumeReviewStepError, type ResumeReviewStepErrorCode };

/** §8's error-vocabulary table (same as Spec 09 §5.1/§8): maps the typed
 *  exceptions resumeOrchestratorRun/recordHumanReview can throw onto the
 *  Slack-facing error codes FR-13 names. */
function classifyResumeError(err: unknown): ResumeReviewStepError {
  if (err instanceof ResumeValidationError) {
    return new ResumeReviewStepError("SUSPENDED_STEP_NOT_FOUND", err.message, { cause: err });
  }
  if (err instanceof ReviewerIndependenceError) {
    return new ResumeReviewStepError("SELF_REVIEW_FORBIDDEN", err.message, { cause: err });
  }
  if (err instanceof NotAssignedError) {
    return new ResumeReviewStepError("NOT_ASSIGNED", err.message, { cause: err });
  }
  if (err instanceof SameReviewerNotAllowedError || err instanceof ReviewAlreadyCompleteError) {
    return new ResumeReviewStepError("ALREADY_DECIDED", err.message, { cause: err });
  }
  if (err instanceof ValidationError) {
    const code: ResumeReviewStepErrorCode = err.field === "rationale" ? "RATIONALE_REQUIRED" : "VALIDATION_ERROR";
    return new ResumeReviewStepError(code, err.message, { cause: err });
  }
  return new ResumeReviewStepError("VALIDATION_ERROR", err instanceof Error ? err.message : String(err), { cause: err });
}

function deriveWorkflowState(resumed: boolean, finalStatus: ObligationStatus | "still_pending"): ReviewWorkflowState {
  if (!resumed) {
    // §8 idempotent-already-resumed path: the run had already moved past
    // this step (replay). Report whatever the current terminal-ish state
    // implies; "suspended" covers the still-pending re-suspend case
    // (Tier C maker resumed, awaiting checker).
    if (finalStatus === "committed") return "resumed_committed";
    if (finalStatus === "rejected") return "resumed_rejected";
    if (finalStatus === "escalated") return "resumed_escalated";
    return "suspended";
  }
  switch (finalStatus) {
    case "committed":
      return "resumed_committed";
    case "rejected":
      return "resumed_rejected";
    case "escalated":
      return "resumed_escalated";
    default:
      // tier_b_review / tier_c_review / still_pending / tier_a_committed /
      // proposed: the branch re-suspended (Tier C maker submitted,
      // awaiting the checker) rather than finalizing.
      return "suspended";
  }
}

/** Looks up the (runId, stepId) pair for a suspended obligation the same
 *  way Spec 09's BFF does via GET .../run-ref (http-server.ts) — except
 *  in-process, directly against the same SuspendedRunIndexPort, no HTTP
 *  hop, no auth token needed (this read is not behind assertServiceAuth
 *  in the in-process form; the HTTP route's own auth gate is a
 *  transport-layer concern that does not apply to an in-process call). */
async function findRunRef(obligationId: string): Promise<{ runId: string; stepId: "awaitHumanReview" | "awaitSecondHumanReview" } | null> {
  return getOrchestratorRuntime().index.find(obligationId);
}

export interface ResumeReviewStepInput {
  obligationId: string;
  reviewerId: string;
  tier: ReviewTier | "ESCALATE";
  decision: "approve" | "reject";
  rationale: string | null;
  /** Traceability handle (Spec 07 §4's source_ref) — this unit always
   *  passes a serialized {channel, message_ts, user_id} triple. */
  sourceRef: string | null;
  /** Injectable for tests/determinism; defaults to a fresh uuid v4 /
   *  wall-clock ISO datetime. */
  eventId?: string;
  decidedAt?: string;
}

export async function resumeReviewStep(input: ResumeReviewStepInput): Promise<ResumeReviewStepResult> {
  const runRef = await findRunRef(input.obligationId);
  if (!runRef) {
    throw new ResumeReviewStepError(
      "SUSPENDED_STEP_NOT_FOUND",
      `no suspended run recorded for obligation ${input.obligationId}.`
    );
  }

  // FR-24: Spec 07's canonical HumanReviewSubmittedEvent, imported
  // unchanged and constructed by human-review-event.ts's pure
  // buildHumanReviewSubmittedEvent — see that file's doc comment and
  // __tests__/human-review-event-identity.test.ts for the direct
  // regression test proving this is field-identical (except `source`) to
  // the console path's construction.
  const review = buildHumanReviewSubmittedEvent({
    obligationId: input.obligationId,
    reviewerId: input.reviewerId,
    tier: input.tier,
    decision: input.decision,
    rationale: input.rationale,
    sourceRef: input.sourceRef,
    eventId: input.eventId,
    decidedAt: input.decidedAt
  });

  let resumeResult: { resumed: boolean; finalStatus: ObligationStatus | "still_pending" };
  try {
    resumeResult = await resumeOrchestratorRun({
      runId: runRef.runId,
      stepId: runRef.stepId,
      obligation_id: input.obligationId,
      review
    });
  } catch (err) {
    throw classifyResumeError(err);
  }

  // Tier A never reaches this function in practice (Tier A has no human
  // review step at all, per Spec 07 FR-19 / this unit's FR-4) — narrowed
  // explicitly here only to satisfy getReviewGate's wire-tier parameter
  // type, which has no "A" member.
  const wireTier: "B" | "C" | "ESCALATE" = input.tier === "A" ? "B" : input.tier;
  const reviewGate = await getReviewGate(input.obligationId, input.reviewerId, wireTier);
  const workflowState = deriveWorkflowState(resumeResult.resumed, resumeResult.finalStatus);

  return { obligationStatus: resumeResult.finalStatus, workflowState, reviewGate };
}

// Re-exported so callers (block-actions.ts) don't need a second import of
// assertServiceAuth for the rare case they need to pre-flight-check
// configuration (e.g. at process startup / health checks).
export { assertServiceAuth };
