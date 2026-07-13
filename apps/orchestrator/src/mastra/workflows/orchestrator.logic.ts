// Spec 08 — pure, deterministic, I/O-free orchestrator logic. Everything
// here is unit-testable without Mastra, Neo4j, or an LLM: tier overrides
// (FR-11–FR-13), the two-phase CommitPlan builders (FR-15/FR-16 pre-review
// and FR-27–FR-31 finalize), outcome computation (FR-26), proposalId
// derivation (NFR-4), the default in-memory SuspendedRunIndexPort (§4.6 /
// §13 item 2), and the review-gate view derivation (FR-24a).
//
// CRITICAL INVARIANT (the whole point of this spec): NO builder below —
// pre-review or finalize — ever populates `nodes.humanReviews` or a
// `REVIEWED_BY` edge. Every HumanReview write goes exclusively through
// Spec 07's `recordHumanReview`, called by `resumeOrchestratorRun`
// (FR-21a) at reviewer-submit time, never deferred to a commit step here.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { CommitPlan, CreateInput } from "@sentinel-act/graph-db";
import type { Obligation, ProcessTask, GraphEdge, HumanReview } from "@sentinel-act/graph-schema";
import { routeTier } from "../scorers/risk-score.scorer.js";
import type { TierDecision, TierRouteInput, ProcessTaskDraft } from "../scorers/risk-score.scorer.js";
import type { ReviewOutcome } from "../agents/monitoring-and-audit.agent.js";
import type {
  ObligationPipelineState,
  ObligationStatus,
  ReviewSlot,
  SuspendedRunIndexPort,
  SuspendedRunIndexEntry
} from "./orchestrator.types.js";

// ---------------------------------------------------------------------------
// Orchestrator-level tier reasons (FR-12/FR-13) — layered on top of Spec
// 05's own TierRouteReason union.
// ---------------------------------------------------------------------------

export const GROUNDING_BORDERLINE_FLOOR = "GROUNDING_BORDERLINE_FLOOR";
export const HEURISTIC_OVERWRITE_FLOOR = "HEURISTIC_OVERWRITE_FLOOR";

// ---------------------------------------------------------------------------
// FR-11: normalize hasContradiction before routeTier.
// ---------------------------------------------------------------------------

/** FR-11: `verification.contradiction || verification.verdict === "fail"`.
 *  This is the Orchestrator-side normalization Spec 04 §13 asked for;
 *  routeTier consumes the resulting boolean (plus groundingScore
 *  directly, superseding Spec 04's older verdict-based workaround). */
export function normalizeHasContradiction(verification: { contradiction: boolean; verdict: string }): boolean {
  return verification.contradiction || verification.verdict === "fail";
}

// ---------------------------------------------------------------------------
// FR-12/FR-13: Orchestrator-level tier-floor overrides.
// ---------------------------------------------------------------------------

/** FR-12: when the grounding verdict is "borderline", force tier to at
 *  least "B" even if routeTier alone returned "A". */
export function applyBorderlineFloor(decision: TierDecision, verdict: string): TierDecision {
  if (verdict === "borderline" && decision.tier === "A") {
    return { tier: "B", reasons: [...decision.reasons, GROUNDING_BORDERLINE_FLOOR] as TierDecision["reasons"] };
  }
  return decision;
}

/** FR-13: when the overwrite match is "heuristic" (unconfirmed), force
 *  tier to at least "B" even if the risk-score tier is "A". */
export function applyHeuristicOverwriteFloor(decision: TierDecision, matchPath: "explicit" | "heuristic" | null): TierDecision {
  if (matchPath === "heuristic" && decision.tier === "A") {
    return { tier: "B", reasons: [...decision.reasons, HEURISTIC_OVERWRITE_FLOOR] as TierDecision["reasons"] };
  }
  return decision;
}

/** FR-11–FR-13 composed: pure `routeTier` then both Orchestrator floors,
 *  in order. */
export function computeTierDecision(
  input: TierRouteInput,
  verdict: string,
  matchPath: "explicit" | "heuristic" | null
): TierDecision {
  const base = routeTier(input);
  return applyHeuristicOverwriteFloor(applyBorderlineFloor(base, verdict), matchPath);
}

// ---------------------------------------------------------------------------
// FR-23: second-review requirement.
// ---------------------------------------------------------------------------

export function requiresSecondReview(tier: TierDecision["tier"]): boolean {
  return tier === "C" || tier === "ESCALATE";
}

// ---------------------------------------------------------------------------
// FR-15 pre-review status table.
// ---------------------------------------------------------------------------

export function preReviewStatusForTier(tier: TierDecision["tier"]): ObligationStatus {
  switch (tier) {
    case "A":
      return "tier_a_committed";
    case "B":
      return "tier_b_review";
    case "C":
      return "tier_c_review";
    case "ESCALATE":
      return "escalated";
  }
}

// ---------------------------------------------------------------------------
// NFR-4: deterministic proposalId for every commitProposal call.
// ---------------------------------------------------------------------------

export function deriveProposalId(runId: string, stepId: string, obligationId: string): string {
  return `${runId}:${stepId}:${obligationId}`;
}

function toIsoDate(value: string): string {
  return value.slice(0, 10);
}

// ---------------------------------------------------------------------------
// FR-15/FR-16: pre-review CommitPlan. Contains the new Obligation +
// ProcessTask nodes and the DERIVED_FROM/APPLIES_TO/MAPPED_TO edges. NEVER
// a SupersessionInstruction/finalizeSupersessions (FR-16). Adds a plain
// SUPERSEDES edge only when matchPath === "explicit".
// ---------------------------------------------------------------------------

export interface PreReviewCommitInput {
  state: ObligationPipelineState;
  /** name -> category_id for resolving APPLIES_TO edges (FR-15). Names not
   *  present here are skipped (they are unresolved categories). */
  categoryIdByName: Record<string, string>;
  /** ISO date stamped as valid_from on the new nodes. */
  effectiveDate: string;
  /** FR-33: Change-and-Delta redline merged onto the ProcessTask draft. */
  redline?: Partial<ProcessTaskDraft> | null;
}

export function buildPreReviewCommitPlan(input: PreReviewCommitInput): CommitPlan {
  const { state, categoryIdByName, effectiveDate, redline } = input;
  const { proposal, mapping, verification, tierDecision } = state;
  const validFrom = toIsoDate(effectiveDate);

  const obligation: CreateInput<Obligation> = {
    obligation_id: state.obligation_id,
    derived_from_clause_id: proposal.derived_from_clause_id || state.clause_id,
    category: proposal.category,
    requirement_text: proposal.requirement_text,
    trigger_event: proposal.trigger_event,
    deadline_rule: proposal.deadline_rule,
    responsible_role: proposal.responsible_role,
    evidence_required: proposal.evidence_required,
    penalty_ref: proposal.penalty_ref,
    confidence_score: proposal.confidence_score,
    grounding_score: verification.grounding_score,
    status: preReviewStatusForTier(tierDecision.tier),
    valid_from: validFrom,
    valid_to: null
  };

  // FR-33: merge the redline diff over Mapping's draft before the write.
  const mergedDraft: ProcessTaskDraft = { ...mapping.processTaskDraft, ...(redline ?? {}), obligation_id: state.obligation_id };
  const processTask: CreateInput<ProcessTask> = {
    ...mergedDraft,
    task_id: state.task_id,
    valid_from: validFrom,
    valid_to: null
  };

  const edges: GraphEdge[] = [
    { type: "DERIVED_FROM", obligation_id: state.obligation_id, clause_id: obligation.derived_from_clause_id },
    { type: "MAPPED_TO", obligation_id: state.obligation_id, task_id: state.task_id }
  ];

  for (const name of proposal.applies_to_category_names) {
    const categoryId = categoryIdByName[name];
    if (categoryId) {
      edges.push({ type: "APPLIES_TO", obligation_id: state.obligation_id, category_id: categoryId });
    }
  }

  // FR-16: plain lineage-intent SUPERSEDES edge only, no valid_to close.
  const overwrite = mapping.overwriteCheck;
  if (overwrite.overwritesLiveObligation && overwrite.matchPath === "explicit" && overwrite.overwrittenObligationId) {
    edges.push({ type: "SUPERSEDES", from_id: state.obligation_id, to_id: overwrite.overwrittenObligationId });
  }

  return {
    proposalId: deriveProposalId(state.runId, "routeAndPreCommit", state.obligation_id),
    nodes: { obligations: [obligation], processTasks: [processTask] },
    edges
  };
}

// ---------------------------------------------------------------------------
// FR-26: final outcome from the recorded review(s).
// ---------------------------------------------------------------------------

export type FinalOutcome = "tier_a" | "approve" | "reject" | "disagreement";

/** Maps Spec 07's ReviewOutcome (from the last recordHumanReview call) to
 *  this workflow's finalize outcome. AWAITING_SECOND_REVIEWER means the
 *  branch must re-suspend, not finalize — callers must not pass it here. */
export function finalOutcomeFromReviewOutcome(reviewOutcome: ReviewOutcome): FinalOutcome {
  switch (reviewOutcome) {
    case "APPROVED":
      return "approve";
    case "REJECTED":
      return "reject";
    case "ESCALATED_DISAGREEMENT":
      return "disagreement";
    case "AWAITING_SECOND_REVIEWER":
      throw new Error("finalOutcomeFromReviewOutcome called with AWAITING_SECOND_REVIEWER — branch should re-suspend.");
  }
}

// ---------------------------------------------------------------------------
// FR-27–FR-31: finalize CommitPlan. ONLY Obligation.status transitions
// (+ finalizeSupersessions where applicable). NEVER nodes.humanReviews /
// REVIEWED_BY — that data already exists from FR-21a.
// ---------------------------------------------------------------------------

export interface FinalizeCommitInput {
  state: ObligationPipelineState;
  outcome: FinalOutcome;
  /** ISO date used to close a superseded Obligation's valid_to. */
  effectiveDate: string;
}

function isExplicitOverwrite(state: ObligationPipelineState): { oldObligationId: string } | null {
  const o = state.mapping.overwriteCheck;
  if (o.overwritesLiveObligation && o.matchPath === "explicit" && o.overwrittenObligationId) {
    return { oldObligationId: o.overwrittenObligationId };
  }
  return null;
}

/** Returns the finalize CommitPlan, or null when there is nothing to write
 *  (a non-overwriting Tier A item whose pre-review commit was already
 *  final — FR-15 table note / FR-27). */
export function buildFinalizeCommitPlan(input: FinalizeCommitInput): CommitPlan | null {
  const { state, outcome, effectiveDate } = input;
  const proposalId = deriveProposalId(state.runId, "finalizeCommit", state.obligation_id);
  const explicit = isExplicitOverwrite(state);
  const effDate = toIsoDate(effectiveDate);

  switch (outcome) {
    case "tier_a": {
      // FR-27: status stays tier_a_committed (already set). Only close the
      // supersession if this was an explicit overwrite; otherwise nothing
      // to finalize.
      if (!explicit) {
        return null;
      }
      return {
        proposalId,
        nodes: {},
        edges: [],
        finalizeSupersessions: [
          { oldObligationId: explicit.oldObligationId, newObligationId: state.obligation_id, effectiveDate: effDate }
        ]
      };
    }
    case "approve": {
      // FR-28: status -> committed; + finalizeSupersessions iff explicit.
      const plan: CommitPlan = {
        proposalId,
        nodes: {},
        edges: [],
        obligationStatusTransitions: [{ obligation_id: state.obligation_id, newStatus: "committed" }]
      };
      if (explicit) {
        plan.finalizeSupersessions = [
          { oldObligationId: explicit.oldObligationId, newObligationId: state.obligation_id, effectiveDate: effDate }
        ];
      }
      return plan;
    }
    case "reject": {
      // FR-30: status -> rejected. NEVER finalizeSupersessions (a rejected
      // proposal must not close the old Obligation's validity).
      return {
        proposalId,
        nodes: {},
        edges: [],
        obligationStatusTransitions: [{ obligation_id: state.obligation_id, newStatus: "rejected" }]
      };
    }
    case "disagreement": {
      // FR-31: status -> escalated (no-op if already escalated).
      return {
        proposalId,
        nodes: {},
        edges: [],
        obligationStatusTransitions: [{ obligation_id: state.obligation_id, newStatus: "escalated" }]
      };
    }
  }
}

// ---------------------------------------------------------------------------
// §4.6 / §13 item 2: default in-memory SuspendedRunIndexPort. The Neo4j
// side-node variant lives in orchestrator.neo4j-run-index.ts; this one is
// the single-process default and the test double.
// ---------------------------------------------------------------------------

export class InMemorySuspendedRunIndex implements SuspendedRunIndexPort {
  private readonly runs = new Map<string, { runId: string; stepId: SuspendedRunIndexEntry["stepId"] }>();
  private readonly claims = new Map<string, { maker: string | null; checker: string | null }>();

  async record(entry: SuspendedRunIndexEntry): Promise<void> {
    this.runs.set(entry.obligation_id, { runId: entry.runId, stepId: entry.stepId });
  }

  async find(obligation_id: string): Promise<{ runId: string; stepId: SuspendedRunIndexEntry["stepId"] } | null> {
    return this.runs.get(obligation_id) ?? null;
  }

  async clear(obligation_id: string): Promise<void> {
    this.runs.delete(obligation_id);
    this.claims.delete(obligation_id);
  }

  /** §8 open-item-0: atomically assign the caller to whichever slot is
   *  open. Synchronous Map mutation inside this async method IS the
   *  atomicity within a single process (no await between read and write).
   *  Returns null (-> HTTP 409) when both slots are taken. */
  async claim(obligation_id: string, reviewerId: string): Promise<{ slot: ReviewSlot } | null> {
    const current = this.claims.get(obligation_id) ?? { maker: null, checker: null };
    let slot: ReviewSlot | null = null;
    if (current.maker === null) {
      current.maker = reviewerId;
      slot = "maker";
    } else if (current.checker === null && current.maker !== reviewerId) {
      current.checker = reviewerId;
      slot = "checker";
    }
    this.claims.set(obligation_id, current);
    return slot ? { slot } : null;
  }
}

// ---------------------------------------------------------------------------
// FR-24a: review-gate view derivation (Spec 09's ReviewGateView contract).
// Spec 09 is not yet implemented; this is the narrowest shape that
// satisfies its FR-18 redaction claim. The reveal field is non-null only
// once getReviewsVisibleTo returns the complete review set for the caller.
// ---------------------------------------------------------------------------

export type ReviewGateStatus = "awaiting_maker" | "awaiting_checker" | "awaiting_review" | "complete";

export interface ReviewGateView {
  obligation_id: string;
  tier: "B" | "C" | "ESCALATE";
  status: ReviewGateStatus;
  /** Non-null ONLY when the caller is entitled to see every review (Tier
   *  B: after their own single review; Tier C/ESCALATE: after BOTH
   *  reviewers have submitted). Derived purely from getReviewsVisibleTo. */
  reveal: HumanReview[] | null;
}

/** Derives the ReviewGateView from the (already redaction-filtered)
 *  result of Spec 07's getReviewsVisibleTo(obligationId, reviewerId).
 *  `visibleReviews` is [] for a caller who has not submitted yet, even
 *  when another reviewer has — that is the checker-redaction guarantee,
 *  enforced upstream by Spec 07, not re-derived here. */
export function deriveReviewGateView(
  obligationId: string,
  tier: "B" | "C" | "ESCALATE",
  visibleReviews: HumanReview[]
): ReviewGateView {
  if (tier === "B") {
    const complete = visibleReviews.length >= 1;
    return {
      obligation_id: obligationId,
      tier,
      status: complete ? "complete" : "awaiting_review",
      reveal: complete ? visibleReviews : null
    };
  }
  // Tier C / ESCALATE — dual review. getReviewsVisibleTo returns [] until
  // the caller has submitted, and only the full set once BOTH have.
  if (visibleReviews.length >= 2) {
    return { obligation_id: obligationId, tier, status: "complete", reveal: visibleReviews };
  }
  // The caller sees nothing yet: either they have not submitted (redacted
  // to [] even if the other has), or no reviews exist. Distinguish maker
  // vs checker wait by whether the caller themselves has a single review.
  const status: ReviewGateStatus = visibleReviews.length === 1 ? "awaiting_checker" : "awaiting_maker";
  return { obligation_id: obligationId, tier, status, reveal: null };
}

// ---------------------------------------------------------------------------
// FR-24a service-to-service auth (Spec 15 §4.1, SENTINEL_SERVICE_JWT_SECRET).
// Minimal HS256 JWT verification with no external dependency.
// ---------------------------------------------------------------------------

function base64UrlDecode(segment: string): Buffer {
  return Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Verifies an HS256 JWT signed with the shared service secret. Checks the
 *  signature and (if present) the `exp` claim. Returns the decoded payload
 *  on success, or null on any failure. Never throws. */
export function verifyServiceJwt(token: string, secret: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }
    const [headerB64, payloadB64, signatureB64] = parts;
    const expected = createHmac("sha256", secret).update(`${headerB64}.${payloadB64}`).digest();
    const provided = base64UrlDecode(signatureB64);
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      return null;
    }
    const payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf8")) as Record<string, unknown>;
    if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
