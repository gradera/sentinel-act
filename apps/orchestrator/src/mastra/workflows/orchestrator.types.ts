// Spec 08 §4 — data contracts new to the Workflow Orchestrator: its own
// trigger input, per-branch state, the suspend/resume payloads, the
// resume event contract, the forward-declared Change-and-Delta output,
// the suspended-run lookup port, and the audit hand-off event. All graph
// node/edge types are imported from @sentinel-act/graph-schema unchanged;
// all agent DTOs are imported from their owning spec's module unchanged.
//
// Spec 07's canonical `HumanReviewSubmittedEvent` is imported for the
// `.review` field of `HumanReviewSubmissionEvent` — this workflow does
// NOT define a competing `HumanReviewRecord` shape (see §4.3, the
// post-review correction that removed it).
import { z } from "zod";
import type { Clause, Circular, ObligationStatus } from "@sentinel-act/graph-schema";
import type { RegulatoryWatchTriggerEvent } from "../agents/regulatory-watch.types.js";
import type { ObligationProposal } from "../agents/obligation-extraction.types.js";
import type { GroundingVerificationOutput } from "../agents/grounding-verification.types.js";
import type { ProcessTaskDraft, TierDecision, TierRouteInput } from "../scorers/risk-score.scorer.js";
import type { MappingRiskScoringResult } from "../agents/mapping-risk-scoring.agent.js";
import type { HumanReviewSubmittedEvent } from "../agents/monitoring-and-audit.agent.js";

// ---------------------------------------------------------------------------
// §4.1 Workflow input — exactly Spec 02's trigger event, no re-shaping.
// ---------------------------------------------------------------------------

/** The workflow's trigger input is exactly Spec 02's trigger event.
 *  `eventId` is this run's idempotency key. */
export type OrchestratorTriggerInput = RegulatoryWatchTriggerEvent;

// ---------------------------------------------------------------------------
// §4.2 Per-clause / per-proposal branch state.
// ---------------------------------------------------------------------------

export interface ClauseBranchContext {
  runId: string;
  eventId: string;
  clause: Clause;
  circular: Circular;
  knownIntermediaryCategoryNames: string[];
}

export interface ObligationPipelineState {
  runId: string;
  eventId: string;
  clause_id: string;
  circular_id: string;
  proposal: ObligationProposal;
  verification: GroundingVerificationOutput;
  mapping: MappingRiskScoringResult;
  tierRouteInput: TierRouteInput;
  tierDecision: TierDecision;
  /** Assigned once, before the pre-review commit (FR-14). Stable across
   *  suspend/resume; the primary key reviewers act against. */
  obligation_id: string;
  task_id: string;
  /** Populated by the pre-review commit step (FR-15). Present on every
   *  branch that reaches the join, including Tier A. */
  preReviewCommit: {
    committedAt: string;
    supersedesObligationId: string | null;
  } | null;
}

// ---------------------------------------------------------------------------
// §4.3 Suspend / resume payloads.
// ---------------------------------------------------------------------------

export type ReviewSlot = "maker" | "checker";

export interface AwaitHumanReviewSuspendState {
  obligation_id: string;
  task_id: string;
  tierDecision: TierDecision;
  expectedSlot: ReviewSlot;
  /** Internal control-flow bookkeeping ONLY — NOT the independence
   *  mechanism (that is Spec 07's getReviewsVisibleTo, via FR-24a). Only
   *  present once the maker slot is filled (the awaitSecondHumanReview
   *  suspend state). */
  makerReviewId: string | null;
  makerReviewerId: string | null;
  suspendedAt: string;
}

/** The resume envelope this workflow needs (runId/stepId to find and
 *  validate the suspended run), wrapping — not duplicating — Spec 07's
 *  canonical `HumanReviewSubmittedEvent`. `resumeOrchestratorRun` passes
 *  `event.review` directly to `recordHumanReview` unchanged (FR-21a). */
export interface HumanReviewSubmissionEvent {
  runId: string;
  stepId: "awaitHumanReview" | "awaitSecondHumanReview";
  obligation_id: string; // defense-in-depth cross-check against runId (FR-21)
  review: HumanReviewSubmittedEvent;
}

// ---------------------------------------------------------------------------
// §4.5 Change and Delta — forward-declared minimal contract (Spec 06).
// ---------------------------------------------------------------------------

export interface ChangeAndDeltaOutput {
  amendment_id: string;
  target_obligation_id: string | null;
  process_task_redline: Partial<ProcessTaskDraft> | null;
  confidence: number;
  degraded: boolean;
}

// ---------------------------------------------------------------------------
// §4.6 Suspended-run lookup port (obligation_id -> workflow run).
// ---------------------------------------------------------------------------

export interface SuspendedRunIndexEntry {
  obligation_id: string;
  runId: string;
  stepId: "awaitHumanReview" | "awaitSecondHumanReview";
}

export interface SuspendedRunIndexPort {
  record(entry: SuspendedRunIndexEntry): Promise<void>;
  find(obligation_id: string): Promise<{ runId: string; stepId: SuspendedRunIndexEntry["stepId"] } | null>;
  clear(obligation_id: string): Promise<void>;
  /** Spec 08 §8 open-item-0 / claim endpoint: atomically assign a
   *  reviewer to whichever of maker/checker is open. Returns the assigned
   *  slot, or null if neither slot is open (409). */
  claim(obligation_id: string, reviewerId: string): Promise<{ slot: ReviewSlot } | null>;
  /** FR-24a addition (Spec 09 §5's `viewerSlot` derivation for the
   *  review-gate endpoint): a pure, non-mutating read of the current claim
   *  slots for an obligation. Returns null when no claim has ever been
   *  recorded for this obligation (never mutates state — distinct from
   *  `.claim()`, which is additive here and must not change its existing
   *  behavior). */
  getClaimSlots(obligation_id: string): Promise<{ maker: string | null; checker: string | null } | null>;
}

// ---------------------------------------------------------------------------
// §5.6 Audit hand-off (Spec 07, forward-declared call site).
// ---------------------------------------------------------------------------

export type AuditEventKind =
  | "pre_review_commit"
  | "tier_decision"
  | "human_review_submitted"
  | "final_commit"
  | "final_reject"
  | "conflict_reconciled"
  | "run_failed";

export interface AuditEvent {
  run_id: string;
  eventId: string;
  kind: AuditEventKind;
  obligation_id: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
}

// ---------------------------------------------------------------------------
// Run summary (§5.2 workflow outputSchema).
// ---------------------------------------------------------------------------

export type BranchOutcome = "committed" | "suspended" | "rejected" | "escalated" | "failed";

export interface OrchestratorRunSummary {
  runId: string;
  eventId: string;
  branchOutcomes: Array<{ obligation_id: string | null; clause_id: string; outcome: BranchOutcome }>;
}

// ---------------------------------------------------------------------------
// zod schemas. Imported agent DTOs use z.custom<T>() so the runtime type
// is preserved for Mastra's schema inference without re-deriving each
// spec's full shape here (each agent already validates its own output).
// ---------------------------------------------------------------------------

const isoString = z.string().min(1);

export const regulatoryWatchTriggerEventSchema = z.object({
  eventId: z.string().min(1),
  pollRunId: z.string().min(1),
  emittedAt: isoString,
  changeType: z.enum(["new", "amendment"]),
  circular: z.custom<RegulatoryWatchTriggerEvent["circular"]>((v) => v !== null && typeof v === "object"),
  clauses: z.array(z.custom<RegulatoryWatchTriggerEvent["clauses"][number]>((v) => v !== null && typeof v === "object")),
  amendmentContext: z.custom<RegulatoryWatchTriggerEvent["amendmentContext"]>().nullable()
}) satisfies z.ZodType<unknown>;

export const clauseBranchContextSchema = z.object({
  runId: z.string().min(1),
  eventId: z.string().min(1),
  clause: z.custom<Clause>(),
  circular: z.custom<Circular>(),
  knownIntermediaryCategoryNames: z.array(z.string())
});

export const tierDecisionSchema = z.object({
  tier: z.enum(["A", "B", "C", "ESCALATE"]),
  reasons: z.array(z.string())
}) as unknown as z.ZodType<TierDecision>;

export const obligationPipelineStateSchema = z.object({
  runId: z.string().min(1),
  eventId: z.string().min(1),
  clause_id: z.string().min(1),
  circular_id: z.string().min(1),
  proposal: z.custom<ObligationProposal>(),
  verification: z.custom<GroundingVerificationOutput>(),
  mapping: z.custom<MappingRiskScoringResult>(),
  tierRouteInput: z.custom<TierRouteInput>(),
  tierDecision: tierDecisionSchema,
  obligation_id: z.string(),
  task_id: z.string(),
  preReviewCommit: z
    .object({ committedAt: isoString, supersedesObligationId: z.string().nullable() })
    .nullable()
});

export const humanReviewSubmittedEventSchema = z.object({
  event_id: z.string().min(1),
  obligation_id: z.string().min(1),
  reviewer_id: z.string().min(1),
  tier: z.enum(["A", "B", "C"]),
  decision: z.enum(["approve", "reject"]),
  rationale: z.string().nullable(),
  decided_at: isoString,
  source: z.enum(["web-console", "slack"]),
  source_ref: z.string().nullable()
}) as unknown as z.ZodType<HumanReviewSubmittedEvent>;

export const humanReviewSubmissionEventSchema = z.object({
  runId: z.string().min(1),
  stepId: z.enum(["awaitHumanReview", "awaitSecondHumanReview"]),
  obligation_id: z.string().min(1),
  review: humanReviewSubmittedEventSchema
});

export const awaitHumanReviewSuspendStateSchema = z.object({
  obligation_id: z.string().min(1),
  task_id: z.string().min(1),
  tierDecision: tierDecisionSchema,
  expectedSlot: z.enum(["maker", "checker"]),
  makerReviewId: z.string().nullable(),
  makerReviewerId: z.string().nullable(),
  suspendedAt: isoString
});

export const changeAndDeltaOutputSchema = z.object({
  amendment_id: z.string(),
  target_obligation_id: z.string().nullable(),
  process_task_redline: z.custom<Partial<ProcessTaskDraft>>().nullable(),
  confidence: z.number(),
  degraded: z.boolean()
});

export const auditEventSchema = z.object({
  run_id: z.string(),
  eventId: z.string(),
  kind: z.enum([
    "pre_review_commit",
    "tier_decision",
    "human_review_submitted",
    "final_commit",
    "final_reject",
    "conflict_reconciled",
    "run_failed"
  ]),
  obligation_id: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  occurredAt: isoString
});

export const orchestratorRunSummarySchema = z.object({
  runId: z.string(),
  eventId: z.string(),
  branchOutcomes: z.array(
    z.object({
      obligation_id: z.string().nullable(),
      clause_id: z.string(),
      outcome: z.enum(["committed", "suspended", "rejected", "escalated", "failed"])
    })
  )
});

export type { ObligationStatus };
