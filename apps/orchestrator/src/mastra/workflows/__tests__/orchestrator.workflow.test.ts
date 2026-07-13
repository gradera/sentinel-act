// Spec 08 §10 unit tests — all agent/graph/ledger I/O mocked. The most
// load-bearing assertion in the whole spec is FIRST: no finalize CommitPlan
// branch ever contains nodes.humanReviews or a REVIEWED_BY edge. The second
// is the resume-ordering regression: recordHumanReview MUST resolve before
// run.resume, and if it throws, run.resume MUST NOT be called (FR-21a).
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CommitPlan } from "@sentinel-act/graph-db";
import type { MappingRiskScoringResult } from "../../agents/mapping-risk-scoring.agent.js";
import type { ObligationProposal } from "../../agents/obligation-extraction.types.js";
import type { GroundingVerificationOutput } from "../../agents/grounding-verification.types.js";
import type { HumanReviewSubmittedEvent, RecordHumanReviewResult } from "../../agents/monitoring-and-audit.agent.js";
import {
  applyBorderlineFloor,
  applyHeuristicOverwriteFloor,
  buildFinalizeCommitPlan,
  buildPreReviewCommitPlan,
  computeTierDecision,
  deriveProposalId,
  deriveReviewGateView,
  finalOutcomeFromReviewOutcome,
  GROUNDING_BORDERLINE_FLOOR,
  HEURISTIC_OVERWRITE_FLOOR,
  InMemorySuspendedRunIndex,
  normalizeHasContradiction,
  preReviewStatusForTier,
  requiresSecondReview
} from "../orchestrator.logic.js";
import type { FinalOutcome } from "../orchestrator.logic.js";
import { resumeOrchestratorRun } from "../orchestrator.workflow.js";
import type { MonitoringAuditPort, ResumeDeps, WorkflowEnginePort } from "../orchestrator.workflow.js";
import { NotAssignedError, ResumeValidationError, ReviewerIndependenceError } from "../orchestrator.errors.js";
import type { ObligationPipelineState } from "../orchestrator.types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProposal(overrides: Partial<ObligationProposal> = {}): ObligationProposal {
  return {
    category: "REPORTING",
    requirement_text: "File monthly report",
    trigger_event: "month end",
    deadline_rule: "T+7",
    responsible_role: "Compliance Officer",
    evidence_required: "signed report",
    penalty_ref: null,
    applies_to_category_names: ["Stock Broker"],
    applies_to_unknown_category_names: [],
    derived_from_clause_id: "clause-1",
    confidence_score: 0.9,
    confidence_breakdown: {
      model_self_reported: 0.9,
      field_completeness_penalty: 0,
      ambiguity_penalty: 0,
      graphrag_support_bonus: 0,
      final: 0.9
    },
    extraction_index: 0,
    ...overrides
  } as ObligationProposal;
}

function makeVerification(overrides: Partial<GroundingVerificationOutput> = {}): GroundingVerificationOutput {
  return {
    run_id: "run-1",
    grounding_score: 0.95,
    field_results: [],
    contradiction: false,
    contradiction_details: [],
    verdict: "pass",
    summary: "ok",
    duration_ms: 10,
    ...overrides
  };
}

function makeMapping(overrides: Partial<MappingRiskScoringResult> = {}): MappingRiskScoringResult {
  return {
    processTaskDraft: {
      obligation_id: "will-be-overwritten",
      task_name: "File monthly report",
      owner_role: "Compliance Officer",
      sla_hours: 168,
      system_touchpoint: "portal",
      risk_score: 0.3
    },
    riskScoreExplain: {
      penaltySeverity: 0.3,
      deadlineProximityDays: 20,
      overwritesLiveObligation: false,
      riskScore: 0.3,
      deadlineWeight: 0.33,
      overwriteWeight: 0
    },
    slaConfidence: "high",
    overwriteCheck: { overwritesLiveObligation: false, matchPath: null, overwrittenObligationId: null, degraded: false },
    firstSeenCheck: { isFirstSeenObligationType: false, degraded: false },
    ...overrides
  };
}

function makeState(overrides: Partial<ObligationPipelineState> = {}): ObligationPipelineState {
  const mapping = overrides.mapping ?? makeMapping();
  return {
    runId: "run-1",
    eventId: "event-1",
    clause_id: "clause-1",
    circular_id: "circ-1",
    proposal: makeProposal(),
    verification: makeVerification(),
    mapping,
    tierRouteInput: {
      riskScore: 0.3,
      hasContradiction: false,
      confidenceScore: 0.9,
      groundingScore: 0.95,
      isFirstSeenObligationType: false
    },
    tierDecision: { tier: "A", reasons: ["BASE_TIER_A"] },
    obligation_id: "obl-1",
    task_id: "task-1",
    preReviewCommit: null,
    ...overrides
  };
}

const EXPLICIT_MAPPING = makeMapping({
  overwriteCheck: { overwritesLiveObligation: true, matchPath: "explicit", overwrittenObligationId: "old-obl", degraded: false }
});

/** The single most load-bearing assertion in the spec. */
function assertNoHumanReviewData(plan: CommitPlan | null): void {
  if (plan === null) {
    return;
  }
  expect(Object.prototype.hasOwnProperty.call(plan.nodes, "humanReviews")).toBe(false);
  expect(plan.nodes.humanReviews).toBeUndefined();
  expect(plan.edges.some((e) => e.type === "REVIEWED_BY")).toBe(false);
}

// ---------------------------------------------------------------------------
// 1. Final-commit CommitPlan — NO humanReviews / REVIEWED_BY, all branches.
// ---------------------------------------------------------------------------

describe("buildFinalizeCommitPlan — no HumanReview writes anywhere (FR-27–FR-31)", () => {
  const eff = "2026-07-13";

  it("Tier A explicit supersede (FR-27): finalizeSupersessions only, no HumanReview data", () => {
    const state = makeState({ mapping: EXPLICIT_MAPPING, tierDecision: { tier: "A", reasons: ["BASE_TIER_A"] } });
    const plan = buildFinalizeCommitPlan({ state, outcome: "tier_a", effectiveDate: eff });
    expect(plan).not.toBeNull();
    expect(plan!.finalizeSupersessions).toEqual([{ oldObligationId: "old-obl", newObligationId: "obl-1", effectiveDate: eff }]);
    expect(plan!.obligationStatusTransitions).toBeUndefined();
    assertNoHumanReviewData(plan);
  });

  it("Tier A non-overwrite: no finalize plan needed (pre-review commit was final)", () => {
    const state = makeState({ tierDecision: { tier: "A", reasons: ["BASE_TIER_A"] } });
    const plan = buildFinalizeCommitPlan({ state, outcome: "tier_a", effectiveDate: eff });
    expect(plan).toBeNull();
    assertNoHumanReviewData(plan);
  });

  it("Tier B/C approve (FR-28): status->committed (+finalizeSupersessions iff explicit), no HumanReview data", () => {
    const nonExplicit = buildFinalizeCommitPlan({ state: makeState(), outcome: "approve", effectiveDate: eff });
    expect(nonExplicit!.obligationStatusTransitions).toEqual([{ obligation_id: "obl-1", newStatus: "committed" }]);
    expect(nonExplicit!.finalizeSupersessions).toBeUndefined();
    assertNoHumanReviewData(nonExplicit);

    const explicit = buildFinalizeCommitPlan({ state: makeState({ mapping: EXPLICIT_MAPPING }), outcome: "approve", effectiveDate: eff });
    expect(explicit!.obligationStatusTransitions).toEqual([{ obligation_id: "obl-1", newStatus: "committed" }]);
    expect(explicit!.finalizeSupersessions).toEqual([{ oldObligationId: "old-obl", newObligationId: "obl-1", effectiveDate: eff }]);
    assertNoHumanReviewData(explicit);
  });

  it("reject (FR-30): status->rejected, NEVER finalizeSupersessions, no HumanReview data", () => {
    const plan = buildFinalizeCommitPlan({ state: makeState({ mapping: EXPLICIT_MAPPING }), outcome: "reject", effectiveDate: eff });
    expect(plan!.obligationStatusTransitions).toEqual([{ obligation_id: "obl-1", newStatus: "rejected" }]);
    expect(plan!.finalizeSupersessions).toBeUndefined();
    assertNoHumanReviewData(plan);
  });

  it("disagreement (FR-31): status->escalated, no HumanReview data", () => {
    const plan = buildFinalizeCommitPlan({ state: makeState(), outcome: "disagreement", effectiveDate: eff });
    expect(plan!.obligationStatusTransitions).toEqual([{ obligation_id: "obl-1", newStatus: "escalated" }]);
    assertNoHumanReviewData(plan);
  });
});

// ---------------------------------------------------------------------------
// 2. Pre-review CommitPlan (FR-15/FR-16).
// ---------------------------------------------------------------------------

describe("buildPreReviewCommitPlan (FR-15/FR-16)", () => {
  const eff = "2026-07-13T00:00:00.000Z";

  it.each([
    ["A", "tier_a_committed"],
    ["B", "tier_b_review"],
    ["C", "tier_c_review"],
    ["ESCALATE", "escalated"]
  ] as const)("sets Obligation.status for tier %s -> %s", (tier, status) => {
    const state = makeState({ tierDecision: { tier, reasons: ["BASE_TIER_A"] } });
    const plan = buildPreReviewCommitPlan({ state, categoryIdByName: {}, effectiveDate: eff });
    expect(plan.nodes.obligations![0].status).toBe(status);
  });

  it("never includes a SupersessionInstruction or finalizeSupersessions (FR-16)", () => {
    const plan = buildPreReviewCommitPlan({ state: makeState({ mapping: EXPLICIT_MAPPING }), categoryIdByName: {}, effectiveDate: eff });
    expect(plan.supersessions).toBeUndefined();
    expect(plan.finalizeSupersessions).toBeUndefined();
  });

  it("adds a plain SUPERSEDES edge only when matchPath === explicit (FR-16)", () => {
    const noOverwrite = buildPreReviewCommitPlan({ state: makeState(), categoryIdByName: {}, effectiveDate: eff });
    expect(noOverwrite.edges.some((e) => e.type === "SUPERSEDES")).toBe(false);

    const explicit = buildPreReviewCommitPlan({ state: makeState({ mapping: EXPLICIT_MAPPING }), categoryIdByName: {}, effectiveDate: eff });
    const supersedes = explicit.edges.find((e) => e.type === "SUPERSEDES");
    expect(supersedes).toEqual({ type: "SUPERSEDES", from_id: "obl-1", to_id: "old-obl" });
  });

  it("resolves APPLIES_TO edges only for known category names", () => {
    const plan = buildPreReviewCommitPlan({
      state: makeState(),
      categoryIdByName: { "Stock Broker": "cat-sb" },
      effectiveDate: eff
    });
    expect(plan.edges).toContainEqual({ type: "APPLIES_TO", obligation_id: "obl-1", category_id: "cat-sb" });
  });

  it("merges a Change-and-Delta redline onto the ProcessTask draft (FR-33)", () => {
    const plan = buildPreReviewCommitPlan({
      state: makeState(),
      categoryIdByName: {},
      effectiveDate: eff,
      redline: { task_name: "REDLINED name", sla_hours: 24 }
    });
    expect(plan.nodes.processTasks![0].task_name).toBe("REDLINED name");
    expect(plan.nodes.processTasks![0].sla_hours).toBe(24);
    expect(plan.nodes.processTasks![0].obligation_id).toBe("obl-1");
  });
});

// ---------------------------------------------------------------------------
// 3. Tier override helpers (FR-11–FR-13) — table-driven.
// ---------------------------------------------------------------------------

describe("normalizeHasContradiction (FR-11)", () => {
  it.each([
    [{ contradiction: true, verdict: "pass" }, true],
    [{ contradiction: false, verdict: "fail" }, true],
    [{ contradiction: false, verdict: "borderline" }, false],
    [{ contradiction: false, verdict: "pass" }, false]
  ])("%o -> %s", (input, expected) => {
    expect(normalizeHasContradiction(input)).toBe(expected);
  });
});

describe("applyBorderlineFloor (FR-12)", () => {
  it("forces A -> B when verdict is borderline, adding the reason", () => {
    const out = applyBorderlineFloor({ tier: "A", reasons: ["BASE_TIER_A"] }, "borderline");
    expect(out.tier).toBe("B");
    expect(out.reasons).toContain(GROUNDING_BORDERLINE_FLOOR);
  });
  it.each(["pass", "fail"])("does not change tier for verdict %s", (verdict) => {
    expect(applyBorderlineFloor({ tier: "A", reasons: [] }, verdict).tier).toBe("A");
  });
  it("leaves an already-B tier unchanged", () => {
    expect(applyBorderlineFloor({ tier: "B", reasons: [] }, "borderline").tier).toBe("B");
  });
});

describe("applyHeuristicOverwriteFloor (FR-13)", () => {
  it("forces A -> B when matchPath is heuristic, adding the reason", () => {
    const out = applyHeuristicOverwriteFloor({ tier: "A", reasons: ["BASE_TIER_A"] }, "heuristic");
    expect(out.tier).toBe("B");
    expect(out.reasons).toContain(HEURISTIC_OVERWRITE_FLOOR);
  });
  it.each(["explicit", null] as const)("does not change tier for matchPath %s", (matchPath) => {
    expect(applyHeuristicOverwriteFloor({ tier: "A", reasons: [] }, matchPath).tier).toBe("A");
  });
});

describe("computeTierDecision (FR-11–FR-13 composed) — AC6 borderline floor over a Tier-A risk score", () => {
  it("borderline floor overrides a Tier-A-eligible risk score (AC6)", () => {
    const decision = computeTierDecision(
      { riskScore: 0.1, hasContradiction: false, confidenceScore: 0.99, groundingScore: 0.99, isFirstSeenObligationType: false },
      "borderline",
      null
    );
    expect(decision.tier).toBe("B");
    expect(decision.reasons).toContain(GROUNDING_BORDERLINE_FLOOR);
  });

  it("contradiction escalates regardless of a low risk score (AC4)", () => {
    const decision = computeTierDecision(
      { riskScore: 0.05, hasContradiction: true, confidenceScore: 0.99, groundingScore: 0.99, isFirstSeenObligationType: false },
      "pass",
      null
    );
    expect(decision.tier).toBe("ESCALATE");
  });
});

// ---------------------------------------------------------------------------
// 4. requiresSecondReview — table-driven over all four tiers.
// ---------------------------------------------------------------------------

describe("requiresSecondReview (FR-23)", () => {
  it.each([
    ["A", false],
    ["B", false],
    ["C", true],
    ["ESCALATE", true]
  ] as const)("%s -> %s", (tier, expected) => {
    expect(requiresSecondReview(tier)).toBe(expected);
  });
});

describe("preReviewStatusForTier", () => {
  it.each([
    ["A", "tier_a_committed"],
    ["B", "tier_b_review"],
    ["C", "tier_c_review"],
    ["ESCALATE", "escalated"]
  ] as const)("%s -> %s", (tier, status) => {
    expect(preReviewStatusForTier(tier)).toBe(status);
  });
});

// ---------------------------------------------------------------------------
// 5. proposalId (NFR-4).
// ---------------------------------------------------------------------------

describe("deriveProposalId (NFR-4)", () => {
  it("is exactly ${runId}:${stepId}:${obligation_id}", () => {
    expect(deriveProposalId("run-1", "routeAndPreCommit", "obl-1")).toBe("run-1:routeAndPreCommit:obl-1");
    expect(deriveProposalId("run-1", "finalizeCommit", "obl-1")).toBe("run-1:finalizeCommit:obl-1");
  });
  it("is used by both commit builders", () => {
    const pre = buildPreReviewCommitPlan({ state: makeState(), categoryIdByName: {}, effectiveDate: "2026-07-13" });
    expect(pre.proposalId).toBe("run-1:routeAndPreCommit:obl-1");
    const fin = buildFinalizeCommitPlan({ state: makeState(), outcome: "approve", effectiveDate: "2026-07-13" });
    expect(fin!.proposalId).toBe("run-1:finalizeCommit:obl-1");
  });
});

// ---------------------------------------------------------------------------
// 6. finalOutcomeFromReviewOutcome.
// ---------------------------------------------------------------------------

describe("finalOutcomeFromReviewOutcome (FR-26)", () => {
  it.each([
    ["APPROVED", "approve"],
    ["REJECTED", "reject"],
    ["ESCALATED_DISAGREEMENT", "disagreement"]
  ] as const)("%s -> %s", (input, expected) => {
    expect(finalOutcomeFromReviewOutcome(input)).toBe(expected as FinalOutcome);
  });
  it("throws for AWAITING_SECOND_REVIEWER (should re-suspend, not finalize)", () => {
    expect(() => finalOutcomeFromReviewOutcome("AWAITING_SECOND_REVIEWER")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 7. resumeOrchestratorRun — the FR-21a ordering regression + validation.
// ---------------------------------------------------------------------------

function makeSubmissionEvent(overrides: Partial<HumanReviewSubmittedEvent> = {}, envelope: Partial<{ runId: string; stepId: "awaitHumanReview" | "awaitSecondHumanReview"; obligation_id: string }> = {}) {
  const review: HumanReviewSubmittedEvent = {
    event_id: "evt-1",
    obligation_id: "obl-1",
    reviewer_id: "co-anita",
    tier: "B",
    decision: "approve",
    rationale: null,
    decided_at: "2026-07-13T10:00:00.000Z",
    source: "web-console",
    source_ref: null,
    ...overrides
  };
  return {
    runId: envelope.runId ?? "run-1",
    stepId: envelope.stepId ?? ("awaitHumanReview" as const),
    obligation_id: envelope.obligation_id ?? "obl-1",
    review
  };
}

function makeRecordResult(outcome: RecordHumanReviewResult["reviewOutcome"] = "APPROVED"): RecordHumanReviewResult {
  return {
    humanReview: {} as RecordHumanReviewResult["humanReview"],
    reviewOutcome: outcome,
    allReviewsForObligation: [],
    ledgerEntry: {} as RecordHumanReviewResult["ledgerEntry"]
  };
}

function buildResumeDeps(overrides: {
  order?: string[];
  recordImpl?: MonitoringAuditPort["recordHumanReview"];
  suspendedStep?: "awaitHumanReview" | "awaitSecondHumanReview" | null;
  makerReviewerId?: string | null;
} = {}): { deps: ResumeDeps; record: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn> } {
  const order = overrides.order ?? [];
  const record = vi.fn(
    overrides.recordImpl ??
      (async () => {
        order.push("record");
        return makeRecordResult();
      })
  );
  const resume = vi.fn(async () => {
    order.push("resume");
    return { finalStatus: "committed" as const };
  });
  const index = new InMemorySuspendedRunIndex();
  const engine: WorkflowEnginePort = {
    start: vi.fn(async () => ({ runId: "run-1" })),
    resume,
    currentSuspendedStep: vi.fn(async () => ("suspendedStep" in overrides ? overrides.suspendedStep! : "awaitHumanReview")),
    getMakerReviewerId: vi.fn(async () => overrides.makerReviewerId ?? null),
    getObligationStatus: vi.fn(async () => "tier_b_review" as const)
  };
  const monitoring: MonitoringAuditPort = { recordHumanReview: record, getReviewsVisibleTo: vi.fn(async () => []) };
  const deps: ResumeDeps = { index, monitoring, engine, auditLog: vi.fn(async () => undefined), referenceNow: () => "2026-07-13T10:00:00.000Z" };
  return { deps, record, resume };
}

describe("resumeOrchestratorRun — FR-21a ordering", () => {
  it("calls recordHumanReview and RESOLVES it BEFORE run.resume (regression for the write-path bug)", async () => {
    const order: string[] = [];
    const { deps, record, resume } = buildResumeDeps({ order });
    await deps.index.record({ obligation_id: "obl-1", runId: "run-1", stepId: "awaitHumanReview" });

    await resumeOrchestratorRun(makeSubmissionEvent(), deps);

    expect(record).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["record", "resume"]);
  });

  it("does NOT call run.resume when recordHumanReview throws; error propagates unchanged", async () => {
    const boom = new Error("ReviewerIndependenceError from Spec 07");
    const { deps, resume } = buildResumeDeps({ recordImpl: async () => { throw boom; } });
    await deps.index.record({ obligation_id: "obl-1", runId: "run-1", stepId: "awaitHumanReview" });

    await expect(resumeOrchestratorRun(makeSubmissionEvent(), deps)).rejects.toBe(boom);
    expect(resume).not.toHaveBeenCalled();
  });
});

describe("resumeOrchestratorRun — validation (§8)", () => {
  it("rejects a runId mismatch (FR-21)", async () => {
    const { deps } = buildResumeDeps();
    await deps.index.record({ obligation_id: "obl-1", runId: "run-OTHER", stepId: "awaitHumanReview" });
    await expect(resumeOrchestratorRun(makeSubmissionEvent(), deps)).rejects.toBeInstanceOf(ResumeValidationError);
  });

  it("rejects an obligation_id mismatch between envelope and review", async () => {
    const { deps } = buildResumeDeps();
    await deps.index.record({ obligation_id: "obl-1", runId: "run-1", stepId: "awaitHumanReview" });
    const event = makeSubmissionEvent({ obligation_id: "obl-DIFFERENT" });
    await expect(resumeOrchestratorRun(event, deps)).rejects.toBeInstanceOf(ResumeValidationError);
  });

  it("rejects a wrong stepId for the run's actual suspended step", async () => {
    const { deps } = buildResumeDeps();
    await deps.index.record({ obligation_id: "obl-1", runId: "run-1", stepId: "awaitHumanReview" });
    const event = makeSubmissionEvent({}, { stepId: "awaitSecondHumanReview" });
    await expect(resumeOrchestratorRun(event, deps)).rejects.toBeInstanceOf(ResumeValidationError);
  });

  it("rejects same-reviewer maker/checker with ReviewerIndependenceError, no record call (FR-25)", async () => {
    const { deps, record, resume } = buildResumeDeps({ suspendedStep: "awaitSecondHumanReview", makerReviewerId: "co-anita" });
    await deps.index.record({ obligation_id: "obl-1", runId: "run-1", stepId: "awaitSecondHumanReview" });
    const event = makeSubmissionEvent({ reviewer_id: "co-anita", tier: "C", rationale: "x" }, { stepId: "awaitSecondHumanReview" });
    await expect(resumeOrchestratorRun(event, deps)).rejects.toBeInstanceOf(ReviewerIndependenceError);
    expect(record).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it("returns { resumed: false } for an already-resumed step (idempotent replay)", async () => {
    const { deps, record, resume } = buildResumeDeps({ suspendedStep: null });
    await deps.index.record({ obligation_id: "obl-1", runId: "run-1", stepId: "awaitHumanReview" });
    const out = await resumeOrchestratorRun(makeSubmissionEvent(), deps);
    expect(out.resumed).toBe(false);
    expect(record).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 7a. resumeOrchestratorRun — FR-20/FR-31 claimed-slot enforcement. Closes
// the gap where any reviewer_id could submit a maker/checker decision on a
// Tier C / ESCALATE item without ever having claimed that slot via
// SuspendedRunIndexPort.claim.
// ---------------------------------------------------------------------------

describe("resumeOrchestratorRun — FR-20/FR-31 claimed-slot enforcement", () => {
  it("Tier B never requires a claimed slot (no maker/checker split, no claim() call made)", async () => {
    const { deps, record, resume } = buildResumeDeps();
    await deps.index.record({ obligation_id: "obl-1", runId: "run-1", stepId: "awaitHumanReview" });
    const event = makeSubmissionEvent({ tier: "B", reviewer_id: "co-anita" });
    await resumeOrchestratorRun(event, deps);
    expect(record).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("rejects a Tier C maker resume with NotAssignedError when no slot has ever been claimed", async () => {
    const { deps, record, resume } = buildResumeDeps();
    await deps.index.record({ obligation_id: "obl-1", runId: "run-1", stepId: "awaitHumanReview" });
    const event = makeSubmissionEvent({ tier: "C", reviewer_id: "someone", rationale: "x" });
    await expect(resumeOrchestratorRun(event, deps)).rejects.toBeInstanceOf(NotAssignedError);
    expect(record).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it("rejects a Tier C maker resume with NotAssignedError when a DIFFERENT reviewer holds the claimed maker slot", async () => {
    const { deps, record, resume } = buildResumeDeps();
    await deps.index.record({ obligation_id: "obl-1", runId: "run-1", stepId: "awaitHumanReview" });
    await deps.index.claim("obl-1", "co-anita");
    const event = makeSubmissionEvent({ tier: "C", reviewer_id: "someone-else", rationale: "x" });
    await expect(resumeOrchestratorRun(event, deps)).rejects.toBeInstanceOf(NotAssignedError);
    expect(record).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it("accepts a Tier C maker resume when the reviewer genuinely holds the claimed maker slot", async () => {
    const { deps, record, resume } = buildResumeDeps();
    await deps.index.record({ obligation_id: "obl-1", runId: "run-1", stepId: "awaitHumanReview" });
    await deps.index.claim("obl-1", "co-anita");
    const event = makeSubmissionEvent({ tier: "C", reviewer_id: "co-anita", rationale: "x" });
    await resumeOrchestratorRun(event, deps);
    expect(record).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("rejects a Tier C checker resume with NotAssignedError when the checker slot was never claimed (distinct reviewer from maker, so ReviewerIndependenceError does not fire first)", async () => {
    const { deps, record, resume } = buildResumeDeps({ suspendedStep: "awaitSecondHumanReview", makerReviewerId: "co-anita" });
    await deps.index.record({ obligation_id: "obl-1", runId: "run-1", stepId: "awaitSecondHumanReview" });
    const event = makeSubmissionEvent({ reviewer_id: "co-bob", tier: "C", rationale: "x" }, { stepId: "awaitSecondHumanReview" });
    await expect(resumeOrchestratorRun(event, deps)).rejects.toBeInstanceOf(NotAssignedError);
    expect(record).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it("accepts a Tier C checker resume when the reviewer genuinely holds the claimed checker slot", async () => {
    const { deps, record, resume } = buildResumeDeps({ suspendedStep: "awaitSecondHumanReview", makerReviewerId: "co-anita" });
    await deps.index.record({ obligation_id: "obl-1", runId: "run-1", stepId: "awaitSecondHumanReview" });
    await deps.index.claim("obl-1", "co-anita"); // maker
    await deps.index.claim("obl-1", "co-bob"); // checker
    const event = makeSubmissionEvent({ reviewer_id: "co-bob", tier: "C", rationale: "x" }, { stepId: "awaitSecondHumanReview" });
    await resumeOrchestratorRun(event, deps);
    expect(record).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 8. review-gate view derivation (FR-24a) + SuspendedRunIndex.claim (§8.0).
// ---------------------------------------------------------------------------

describe("deriveReviewGateView (FR-24a) — checker redaction", () => {
  it("Tier C: reveals nothing until the caller has submitted (getReviewsVisibleTo returns [])", () => {
    const view = deriveReviewGateView("obl-1", "C", []);
    expect(view.reveal).toBeNull();
    expect(view.status).toBe("awaiting_maker");
  });
  it("Tier C: caller has one visible review -> awaiting_checker, still no reveal", () => {
    const view = deriveReviewGateView("obl-1", "C", [{ reviewer_id: "co-anita" } as never]);
    expect(view.reveal).toBeNull();
    expect(view.status).toBe("awaiting_checker");
  });
  it("Tier C: both reviews visible -> complete + reveal both", () => {
    const reviews = [{ reviewer_id: "a" }, { reviewer_id: "b" }] as never[];
    const view = deriveReviewGateView("obl-1", "C", reviews);
    expect(view.status).toBe("complete");
    expect(view.reveal).toHaveLength(2);
  });
  it("Tier B: complete after the single review is visible", () => {
    const view = deriveReviewGateView("obl-1", "B", [{ reviewer_id: "a" } as never]);
    expect(view.status).toBe("complete");
    expect(view.reveal).toHaveLength(1);
  });
});

describe("InMemorySuspendedRunIndex.claim (§8 open-item-0)", () => {
  let index: InMemorySuspendedRunIndex;
  beforeEach(() => {
    index = new InMemorySuspendedRunIndex();
  });

  it("assigns maker then checker to distinct reviewers, then 409 (null)", async () => {
    expect(await index.claim("obl-1", "r1")).toEqual({ slot: "maker" });
    expect(await index.claim("obl-1", "r2")).toEqual({ slot: "checker" });
    expect(await index.claim("obl-1", "r3")).toBeNull();
  });

  it("does not let the same reviewer take both slots", async () => {
    expect(await index.claim("obl-1", "r1")).toEqual({ slot: "maker" });
    expect(await index.claim("obl-1", "r1")).toBeNull();
  });
});
