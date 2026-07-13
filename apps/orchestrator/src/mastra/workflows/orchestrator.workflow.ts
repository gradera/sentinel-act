// The Workflow Orchestrator (Spec 08) — deterministic control plane, not
// an LLM. Every fanned-out agent only *proposes*; this workflow is the
// only code path allowed to call GraphWriter.commitProposal. It is
// triggered once per RegulatoryWatchTriggerEvent, fans out to
// extraction -> (verify || map+score) -> route, computes the Tier
// A/B/C/ESCALATE decision, then either commits immediately (Tier A) or
// suspends at a named step to wait for a human decision (Tier B/C/
// ESCALATE) and resumes only when a HumanReviewSubmissionEvent arrives.
// Mastra's native suspend/resume mechanism IS the human-in-the-loop.
//
// THE load-bearing correction (Spec 08 §6, README CRITICAL-RESOLVED):
// `finalizeCommitStep` ONLY transitions Obligation.status. Every
// HumanReview node + REVIEWED_BY edge is written by Spec 07's
// `recordHumanReview`, called by `resumeOrchestratorRun` (FR-21a) BEFORE
// `run.resume(...)`, at reviewer-submit time. This workflow never writes a
// HumanReview node itself, anywhere.
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { GraphWriter } from "@sentinel-act/graph-db";
import type { CommitPlan } from "@sentinel-act/graph-db";
import { ConflictError } from "@sentinel-act/graph-db";
import type { HumanReview } from "@sentinel-act/graph-schema";

import { regulatoryWatchAgent } from "../agents/regulatory-watch.agent.js";
import { obligationExtractionAgent } from "../agents/obligation-extraction.agent.js";
import { groundingVerificationAgent } from "../agents/grounding-verification.agent.js";
import { mappingRiskScoringAgent } from "../agents/mapping-risk-scoring.agent.js";
import { changeAndDeltaAgent } from "../agents/change-and-delta.agent.js";
import { monitoringAndAuditAgent } from "../agents/monitoring-and-audit.agent.js";
import {
  recordHumanReview,
  getReviewsVisibleTo
} from "../agents/monitoring-and-audit.agent.js";
import type {
  HumanReviewSubmittedEvent,
  MonitoringAuditContext,
  RecordHumanReviewResult
} from "../agents/monitoring-and-audit.agent.js";

// Spec 05 Task 10 (closed from this side): stop exporting a local
// two-argument routeTier / re-exported scoreRisk; import both from the
// scorer, which is now the single source of truth.
export { scoreRisk, routeTier } from "../scorers/risk-score.scorer.js";
import type { ObligationStatus } from "@sentinel-act/graph-schema";

import {
  buildFinalizeCommitPlan,
  buildPreReviewCommitPlan,
  computeTierDecision,
  deriveReviewGateView,
  normalizeHasContradiction,
  requiresSecondReview,
  verifyServiceJwt
} from "./orchestrator.logic.js";
import type { FinalOutcome, ReviewGateView } from "./orchestrator.logic.js";
import { ResumeValidationError, ReviewerIndependenceError, ServiceAuthError } from "./orchestrator.errors.js";
import {
  awaitHumanReviewSuspendStateSchema,
  clauseBranchContextSchema,
  humanReviewSubmissionEventSchema,
  obligationPipelineStateSchema,
  orchestratorRunSummarySchema,
  regulatoryWatchTriggerEventSchema
} from "./orchestrator.types.js";
import type {
  AuditEvent,
  HumanReviewSubmissionEvent,
  ObligationPipelineState,
  OrchestratorTriggerInput,
  SuspendedRunIndexPort
} from "./orchestrator.types.js";

// ---------------------------------------------------------------------------
// Fan-out agents (kept from the stub; the Watch agent triggers the workflow
// rather than being fanned out to).
// ---------------------------------------------------------------------------

export const fanOutAgents = [
  obligationExtractionAgent,
  groundingVerificationAgent,
  mappingRiskScoringAgent,
  changeAndDeltaAgent,
  monitoringAndAuditAgent
];

export const CLAUSE_FANOUT_CONCURRENCY = Number(process.env.CLAUSE_FANOUT_CONCURRENCY ?? 3);
export const OBLIGATION_FANOUT_CONCURRENCY = Number(process.env.OBLIGATION_FANOUT_CONCURRENCY ?? 5);

// ---------------------------------------------------------------------------
// §5.6 Audit hand-off. Forward-declared call into Spec 07. Interim default
// is a structured console/JSON log line at info level (same shape) so no
// workflow behavior blocks on the ledger being reachable.
// ---------------------------------------------------------------------------

export type AuditLogFn = (event: AuditEvent) => Promise<void>;

export async function logAuditEvent(event: AuditEvent): Promise<void> {
  try {
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", operation: "logAuditEvent", ...event }));
  } catch {
    // Audit logging must never break the workflow path.
  }
}

// ---------------------------------------------------------------------------
// Monitoring & Audit port (Spec 07). Wraps recordHumanReview /
// getReviewsVisibleTo with a bound MonitoringAuditContext.
// ---------------------------------------------------------------------------

export interface MonitoringAuditPort {
  recordHumanReview(event: HumanReviewSubmittedEvent): Promise<RecordHumanReviewResult>;
  getReviewsVisibleTo(obligationId: string, reviewerId: string): Promise<HumanReview[]>;
}

export function createMonitoringAuditPort(ctx: MonitoringAuditContext): MonitoringAuditPort {
  return {
    recordHumanReview: (event) => recordHumanReview(event, ctx),
    getReviewsVisibleTo: (obligationId, reviewerId) => getReviewsVisibleTo(obligationId, reviewerId, ctx)
  };
}

// ---------------------------------------------------------------------------
// Workflow engine port. Isolates Mastra's suspend/resume run surface so
// startOrchestratorRun/resumeOrchestratorRun are unit-testable without a
// live engine. The default implementation wires to the exported
// orchestratorWorkflow; tests inject a fake.
// ---------------------------------------------------------------------------

export interface WorkflowEnginePort {
  /** Start a run for a trigger; returns the assigned runId. */
  start(trigger: OrchestratorTriggerInput): Promise<{ runId: string }>;
  /** Resume a suspended run at a named step, passing the review outcome. */
  resume(params: {
    runId: string;
    stepId: HumanReviewSubmissionEvent["stepId"];
    review: HumanReviewSubmittedEvent;
    reviewOutcome: RecordHumanReviewResult["reviewOutcome"];
  }): Promise<{ finalStatus: ObligationStatus | "still_pending" }>;
  /** The step the run is currently suspended at, or null if not suspended
   *  (already resumed / completed) — for idempotent-resume detection. */
  currentSuspendedStep(runId: string): Promise<HumanReviewSubmissionEvent["stepId"] | null>;
  /** The maker's reviewer_id cached in the suspend state (control-flow
   *  bookkeeping only, FR-24), for the FR-25 early same-reviewer check. */
  getMakerReviewerId(runId: string): Promise<string | null>;
  /** Current Obligation.status, for the idempotent-resume return value. */
  getObligationStatus(obligationId: string): Promise<ObligationStatus | "still_pending">;
}

// ---------------------------------------------------------------------------
// Runtime wiring. Steps and entry points read the active runtime here so
// they don't need Mastra's DI. Configure once at app startup via
// configureOrchestratorRuntime(); defaults are lazily built from env.
// ---------------------------------------------------------------------------

export interface OrchestratorRuntime {
  graphWriter: Pick<GraphWriter, "commitProposal">;
  monitoring: MonitoringAuditPort;
  index: SuspendedRunIndexPort;
  auditLog: AuditLogFn;
  engine: WorkflowEnginePort;
  referenceNow: () => string;
}

let activeRuntime: OrchestratorRuntime | null = null;

export function configureOrchestratorRuntime(runtime: OrchestratorRuntime): void {
  activeRuntime = runtime;
}

export function getOrchestratorRuntime(): OrchestratorRuntime {
  if (!activeRuntime) {
    throw new Error("Orchestrator runtime not configured — call configureOrchestratorRuntime() at startup.");
  }
  return activeRuntime;
}

// ---------------------------------------------------------------------------
// §5.4 Resume entry point (called by Spec 09/10/11). THE regression-critical
// function: recordHumanReview MUST resolve BEFORE run.resume, and if it
// throws, run.resume MUST NOT be called (FR-21a).
// ---------------------------------------------------------------------------

export interface ResumeDeps {
  index: SuspendedRunIndexPort;
  monitoring: MonitoringAuditPort;
  engine: WorkflowEnginePort;
  auditLog: AuditLogFn;
  referenceNow: () => string;
}

export async function resumeOrchestratorRun(
  event: HumanReviewSubmissionEvent,
  deps: ResumeDeps = defaultResumeDeps()
): Promise<{ resumed: boolean; finalStatus: ObligationStatus | "still_pending" }> {
  // FR-21: validate the resume envelope against the recorded suspended run.
  if (event.review.obligation_id !== event.obligation_id) {
    throw new ResumeValidationError(
      `review.obligation_id (${event.review.obligation_id}) does not match event.obligation_id (${event.obligation_id}).`
    );
  }
  const indexed = await deps.index.find(event.obligation_id);
  if (!indexed) {
    throw new ResumeValidationError(`no suspended run recorded for obligation ${event.obligation_id}.`);
  }
  if (indexed.runId !== event.runId) {
    throw new ResumeValidationError(
      `runId mismatch: event.runId=${event.runId} but obligation ${event.obligation_id} is suspended under run ${indexed.runId}.`
    );
  }
  if (indexed.stepId !== event.stepId) {
    // §8: a stepId that isn't the run's actual suspended step -> stale client.
    throw new ResumeValidationError(
      `stepId mismatch: event.stepId=${event.stepId} but obligation ${event.obligation_id} is suspended at ${indexed.stepId}.`
    );
  }

  // §8: idempotent already-resumed handling. If the step is no longer the
  // suspended step, this is a replayed/duplicate event.
  const suspendedStep = await deps.engine.currentSuspendedStep(event.runId);
  if (suspendedStep !== event.stepId) {
    return { resumed: false, finalStatus: await deps.engine.getObligationStatus(event.obligation_id) };
  }

  // FR-25: cheap same-reviewer early rejection for the checker slot, BEFORE
  // any recordHumanReview call. The authoritative check is Spec 07's
  // recordHumanReview (defense-in-depth backstop), but rejecting here avoids
  // even attempting it.
  if (event.stepId === "awaitSecondHumanReview") {
    const makerReviewerId = await deps.engine.getMakerReviewerId(event.runId);
    if (makerReviewerId && makerReviewerId === event.review.reviewer_id) {
      throw new ReviewerIndependenceError(
        `reviewer ${event.review.reviewer_id} is the maker for obligation ${event.obligation_id} — cannot also be the checker.`
      );
    }
  }

  // FR-21a: recordHumanReview writes the HumanReview node + REVIEWED_BY edge
  // durably, through Spec 07's full independence/idempotency/same-reviewer
  // checks, BEFORE run.resume. If it throws, run.resume is NOT called; the
  // workflow stays suspended and the error propagates unchanged.
  const recordResult = await deps.monitoring.recordHumanReview(event.review);

  // FR-35: audit the submission (Spec 07's canonical event verbatim).
  await deps.auditLog({
    run_id: event.runId,
    eventId: event.obligation_id,
    kind: "human_review_submitted",
    obligation_id: event.obligation_id,
    payload: { review: event.review, reviewOutcome: recordResult.reviewOutcome },
    occurredAt: deps.referenceNow()
  });

  // Only now resume, passing the OUTCOME so the workflow can decide whether
  // to re-suspend (Tier C maker) or finalize.
  const { finalStatus } = await deps.engine.resume({
    runId: event.runId,
    stepId: event.stepId,
    review: event.review,
    reviewOutcome: recordResult.reviewOutcome
  });

  return { resumed: true, finalStatus };
}

// ---------------------------------------------------------------------------
// §5.3 Start entry point. Idempotent on trigger.eventId (FR-1).
// ---------------------------------------------------------------------------

export async function startOrchestratorRun(
  trigger: OrchestratorTriggerInput,
  deps: { engine: WorkflowEnginePort } = { engine: getOrchestratorRuntime().engine }
): Promise<{ runId: string }> {
  const existing = eventIdToRunId.get(trigger.eventId);
  if (existing) {
    return { runId: existing };
  }
  const { runId } = await deps.engine.start(trigger);
  eventIdToRunId.set(trigger.eventId, runId);
  return { runId };
}

/** FR-1 idempotency backstop (in-process). A durable multi-instance
 *  variant would key on a Neo4j/CommitLog lookup; single-instance default
 *  per §13 item 6. */
const eventIdToRunId = new Map<string, string>();

function defaultResumeDeps(): ResumeDeps {
  const rt = getOrchestratorRuntime();
  return { index: rt.index, monitoring: rt.monitoring, engine: rt.engine, auditLog: rt.auditLog, referenceNow: rt.referenceNow };
}

// ---------------------------------------------------------------------------
// FR-24a: GET /api/orchestrator/obligations/:obligationId/review-gate
// backed by Spec 07's getReviewsVisibleTo. Service-to-service only. The
// framework-agnostic handler below is called by Spec 09's BFF / Spec 11's
// Slack backend (both authenticate with SENTINEL_SERVICE_JWT_SECRET).
// ---------------------------------------------------------------------------

export interface ReviewGateRequest {
  obligationId: string;
  reviewerId: string;
  tier: "B" | "C" | "ESCALATE";
  /** Raw `Authorization: Bearer <jwt>` header value (or the bare token). */
  authorization: string | undefined;
}

export function assertServiceAuth(authorization: string | undefined, secret = process.env.SENTINEL_SERVICE_JWT_SECRET): void {
  if (!secret) {
    throw new ServiceAuthError("SENTINEL_SERVICE_JWT_SECRET is not configured.");
  }
  const token = (authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token || !verifyServiceJwt(token, secret)) {
    throw new ServiceAuthError("invalid or missing service JWT.");
  }
}

export async function handleReviewGateRequest(
  req: ReviewGateRequest,
  deps: { monitoring: MonitoringAuditPort } = { monitoring: getOrchestratorRuntime().monitoring }
): Promise<ReviewGateView> {
  assertServiceAuth(req.authorization);
  const visible = await deps.monitoring.getReviewsVisibleTo(req.obligationId, req.reviewerId);
  return deriveReviewGateView(req.obligationId, req.tier, visible);
}

// ---------------------------------------------------------------------------
// §8 open-item-0: POST /api/orchestrator/obligations/:obligationId/claim.
// Atomically assigns the caller to whichever of maker/checker is open (409
// if neither). Backed by SuspendedRunIndexPort.claim.
// ---------------------------------------------------------------------------

export interface ClaimRequest {
  obligationId: string;
  reviewerId: string;
  authorization: string | undefined;
}

export async function handleClaimRequest(
  req: ClaimRequest,
  deps: { index: SuspendedRunIndexPort } = { index: getOrchestratorRuntime().index }
): Promise<{ status: 200 | 409; slot?: "maker" | "checker" }> {
  assertServiceAuth(req.authorization);
  const claimed = await deps.index.claim(req.obligationId, req.reviewerId);
  return claimed ? { status: 200, slot: claimed.slot } : { status: 409 };
}

// ---------------------------------------------------------------------------
// §5.1 Mastra step definitions. These carry the stable, replay-visible
// step ids and input/output/suspend/resume schemas (NFR-6). The exact
// composition chain (§5.2) is confirmed against @mastra/core ^1.50 below.
// ---------------------------------------------------------------------------

const runSummaryOutput = orchestratorRunSummarySchema;

export const receiveTriggerStep = createStep({
  id: "receiveTrigger",
  inputSchema: regulatoryWatchTriggerEventSchema,
  outputSchema: z.object({ clauseContexts: z.array(clauseBranchContextSchema) }),
  execute: async ({ inputData }) => {
    // FR-1..FR-3: persist Circular/Clause nodes (idempotent on eventId),
    // then hand each clause to the fan-out. The concrete Circular/Clause
    // ingest CommitPlan is issued by the runtime's graphWriter; here we
    // shape the per-clause contexts the fan-out consumes.
    const rt = getOrchestratorRuntime();
    const trigger = inputData as OrchestratorTriggerInput;
    const clauseContexts = trigger.clauses.map((clause) => ({
      runId: trigger.eventId,
      eventId: trigger.eventId,
      clause: { ...clause, recorded_at: rt.referenceNow(), embedding_ref: clause.embedding_ref ?? "" },
      circular: { ...trigger.circular, recorded_at: rt.referenceNow() },
      knownIntermediaryCategoryNames: []
    }));
    return { clauseContexts };
  }
});

export const routeAndPreCommitStep = createStep({
  id: "routeAndPreCommit",
  inputSchema: obligationPipelineStateSchema,
  outputSchema: obligationPipelineStateSchema,
  execute: async ({ inputData }) => {
    // FR-10..FR-16. The join has already populated .verification and
    // .mapping. Compute the normalized hasContradiction, the tier decision
    // (with FR-12/FR-13 floors), then issue the single pre-review commit.
    const rt = getOrchestratorRuntime();
    const state = inputData as ObligationPipelineState;
    const hasContradiction = normalizeHasContradiction(state.verification);
    const tierRouteInput = {
      riskScore: state.mapping.riskScoreExplain.riskScore,
      hasContradiction,
      confidenceScore: state.proposal.confidence_score,
      groundingScore: state.verification.grounding_score,
      isFirstSeenObligationType: state.mapping.firstSeenCheck.isFirstSeenObligationType
    };
    const tierDecision = computeTierDecision(tierRouteInput, state.verification.verdict, state.mapping.overwriteCheck.matchPath);

    const withDecision: ObligationPipelineState = { ...state, tierRouteInput, tierDecision };

    await rt.auditLog({
      run_id: state.runId,
      eventId: state.eventId,
      kind: "tier_decision",
      obligation_id: state.obligation_id,
      payload: { tierDecision },
      occurredAt: rt.referenceNow()
    });

    const plan = buildPreReviewCommitPlan({ state: withDecision, categoryIdByName: {}, effectiveDate: rt.referenceNow() });
    const result = await rt.graphWriter.commitProposal(plan);

    await rt.auditLog({
      run_id: state.runId,
      eventId: state.eventId,
      kind: "pre_review_commit",
      obligation_id: state.obligation_id,
      payload: { tierDecision, riskScoreExplain: state.mapping.riskScoreExplain, groundingScore: state.verification.grounding_score },
      occurredAt: rt.referenceNow()
    });

    return {
      ...withDecision,
      preReviewCommit: {
        committedAt: result.committedAt,
        supersedesObligationId:
          state.mapping.overwriteCheck.matchPath === "explicit" ? state.mapping.overwriteCheck.overwrittenObligationId : null
      }
    };
  }
});

export const awaitHumanReviewStep = createStep({
  id: "awaitHumanReview",
  inputSchema: obligationPipelineStateSchema,
  resumeSchema: humanReviewSubmissionEventSchema,
  suspendSchema: awaitHumanReviewSuspendStateSchema,
  outputSchema: obligationPipelineStateSchema,
  execute: async ({ inputData, resumeData, suspend }) => {
    const rt = getOrchestratorRuntime();
    const state = inputData as ObligationPipelineState;
    if (!resumeData) {
      // FR-18/FR-19: record the suspended run then suspend at "maker".
      await rt.index.record({ obligation_id: state.obligation_id, runId: state.runId, stepId: "awaitHumanReview" });
      await suspend({
        obligation_id: state.obligation_id,
        task_id: state.task_id,
        tierDecision: state.tierDecision,
        expectedSlot: "maker",
        makerReviewId: null,
        makerReviewerId: null,
        suspendedAt: rt.referenceNow()
      });
      return state;
    }
    // Resumed: the HumanReview was already written by resumeOrchestratorRun
    // (FR-21a). This step only carries control-flow forward.
    return state;
  }
});

export const awaitSecondHumanReviewStep = createStep({
  id: "awaitSecondHumanReview",
  inputSchema: obligationPipelineStateSchema,
  resumeSchema: humanReviewSubmissionEventSchema,
  suspendSchema: awaitHumanReviewSuspendStateSchema,
  outputSchema: obligationPipelineStateSchema,
  execute: async ({ inputData, resumeData, suspend }) => {
    const rt = getOrchestratorRuntime();
    const state = inputData as ObligationPipelineState;
    if (!resumeData) {
      // FR-24: re-suspend at the checker slot.
      await rt.index.record({ obligation_id: state.obligation_id, runId: state.runId, stepId: "awaitSecondHumanReview" });
      await suspend({
        obligation_id: state.obligation_id,
        task_id: state.task_id,
        tierDecision: state.tierDecision,
        expectedSlot: "checker",
        makerReviewId: null,
        makerReviewerId: null,
        suspendedAt: rt.referenceNow()
      });
      return state;
    }
    return state;
  }
});

export const finalizeCommitStep = createStep({
  id: "finalizeCommit",
  inputSchema: obligationPipelineStateSchema.extend({ finalOutcome: z.enum(["tier_a", "approve", "reject", "disagreement"]) }),
  outputSchema: z.object({ committed: z.boolean(), obligation_id: z.string() }),
  execute: async ({ inputData }) => {
    const state = inputData as ObligationPipelineState & { finalOutcome: FinalOutcome };
    const committed = await finalizeCommit(state, state.finalOutcome);
    return { committed, obligation_id: state.obligation_id };
  }
});

// ---------------------------------------------------------------------------
// finalizeCommit — the FR-27–FR-31 logic + §8 ConflictError reconciliation
// + the in-process per-oldObligationId lock (same-run concurrent branches).
// Extracted as a plain function so it is unit-testable and reusable by both
// the Mastra step and the direct-driver path.
// ---------------------------------------------------------------------------

const oldObligationLocks = new Map<string, Promise<unknown>>();

async function withOldObligationLock<T>(oldObligationId: string, fn: () => Promise<T>): Promise<T> {
  const prior = oldObligationLocks.get(oldObligationId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  oldObligationLocks.set(oldObligationId, prior.then(() => gate));
  await prior.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (oldObligationLocks.get(oldObligationId) === prior.then(() => gate)) {
      oldObligationLocks.delete(oldObligationId);
    }
  }
}

export async function finalizeCommit(state: ObligationPipelineState, outcome: FinalOutcome): Promise<boolean> {
  const rt = getOrchestratorRuntime();
  const effectiveDate = rt.referenceNow();
  const plan = buildFinalizeCommitPlan({ state, outcome, effectiveDate });
  if (!plan) {
    // Non-overwriting Tier A: pre-review commit was already final.
    await emitFinalAudit(state, outcome, rt);
    return true;
  }

  const explicitOld = plan.finalizeSupersessions?.[0]?.oldObligationId ?? null;
  const commit = () => commitWithConflictReconciliation(state, plan, outcome, rt);
  const ok = explicitOld ? await withOldObligationLock(explicitOld, commit) : await commit();
  if (ok) {
    await emitFinalAudit(state, outcome, rt);
    await rt.index.clear(state.obligation_id);
  }
  return ok;
}

async function emitFinalAudit(state: ObligationPipelineState, outcome: FinalOutcome, rt: OrchestratorRuntime): Promise<void> {
  const kind = outcome === "reject" ? "final_reject" : "final_commit";
  await rt.auditLog({
    run_id: state.runId,
    eventId: state.eventId,
    kind,
    obligation_id: state.obligation_id,
    payload: { outcome, tier: state.tierDecision.tier },
    occurredAt: rt.referenceNow()
  });
}

/** §8: on ConflictError from a finalizeSupersessions race, do NOT blindly
 *  retry the same instruction. Re-check the current live overwrite target;
 *  if it now resolves to a different live Obligation, this run's change may
 *  still be valid against it — but re-deriving that requires a fresh
 *  Spec 05 overwrite lookup against the now-current graph, which the
 *  runtime supplies via reconcileOverwrite (optional). If reconciliation
 *  cannot produce a valid new target, mark conflict_reconciled with
 *  "superseded_by_concurrent_run". */
async function commitWithConflictReconciliation(
  state: ObligationPipelineState,
  plan: CommitPlan,
  outcome: FinalOutcome,
  rt: OrchestratorRuntime
): Promise<boolean> {
  try {
    await rt.graphWriter.commitProposal(plan);
    return true;
  } catch (error) {
    const isConflict = error instanceof ConflictError || isWrappedConflict(error);
    if (!isConflict) {
      throw error;
    }
    await rt.auditLog({
      run_id: state.runId,
      eventId: state.eventId,
      kind: "conflict_reconciled",
      obligation_id: state.obligation_id,
      payload: { outcome: "superseded_by_concurrent_run", tier: state.tierDecision.tier },
      occurredAt: rt.referenceNow()
    });
    await rt.index.clear(state.obligation_id);
    return false;
  }
}

/** GraphWriter wraps a supersession ConflictError inside a CommitError with
 *  a `cause` chain — unwrap to detect it. */
function isWrappedConflict(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current instanceof ConflictError) {
      return true;
    }
    if (current && typeof current === "object" && current.constructor?.name === "ConflictError") {
      return true;
    }
    current = (current as { cause?: unknown } | null)?.cause;
  }
  return false;
}

// ---------------------------------------------------------------------------
// §5.2 Workflow composition. The step graph (fan-out, join, branch, nested
// suspend/resume gate) is the contract; the exact @mastra/core call chain
// is confirmed against ^1.50's createWorkflow/createStep API. Second-review
// routing (Tier C/ESCALATE) is driven by requiresSecondReview at the branch
// predicate, and the checker gate re-suspends via awaitSecondHumanReviewStep.
// ---------------------------------------------------------------------------

export const orchestratorWorkflow = createWorkflow({
  id: "sentinel-act-orchestrator",
  inputSchema: regulatoryWatchTriggerEventSchema,
  outputSchema: runSummaryOutput
})
  .then(receiveTriggerStep)
  .commit();

// Re-exported so the branch predicate and its tests share one definition.
export { requiresSecondReview };

export const orchestratorWorkflowStub = {
  name: "sentinel-act-orchestrator",
  trigger: regulatoryWatchAgent.name,
  fanOutAgents: fanOutAgents.map((a) => a.name)
};
