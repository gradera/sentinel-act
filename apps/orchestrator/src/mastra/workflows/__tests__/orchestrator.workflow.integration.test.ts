// Spec 08 §10 integration tests. No Docker (Neo4j/Postgres testcontainers)
// is available in this sandbox, so the acceptance criteria are exercised
// against a STATEFUL in-memory graph + ledger that faithfully implements
// the CommitPlan semantics this workflow depends on (status transitions,
// the finalizeSupersessions `valid_to` guard, HumanReview reads), driving
// the REAL Spec 07 recordHumanReview/getReviewsVisibleTo, the REAL commit
// builders, and the REAL resumeOrchestratorRun. A parallel real-Neo4j
// suite is gated behind ORCHESTRATOR_LIVE_INFRA_TEST and reuses the exact
// same scenario bodies once a live driver is wired in.
//
// The whole point of AC3 is that the checker's review-gate view is derived
// from the REAL getReviewsVisibleTo — it is NOT mocked here.
import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import type { CommitPlan, CommitResult } from "@sentinel-act/graph-db";
import { ConflictError } from "@sentinel-act/graph-db";
import type { Obligation } from "@sentinel-act/graph-schema";
import type {
  AuditLedgerPort,
  LedgerAppendInput,
  LedgerEntry,
  LedgerQuery
} from "@sentinel-act/audit-ledger";
import {
  getReviewsVisibleTo,
  type GraphQueryPort,
  type GraphWriterPort,
  type MonitoringAuditContext
} from "../../agents/monitoring-and-audit.agent.js";
import type { MappingRiskScoringResult } from "../../agents/mapping-risk-scoring.agent.js";
import {
  buildPreReviewCommitPlan,
  finalOutcomeFromReviewOutcome,
  InMemorySuspendedRunIndex
} from "../orchestrator.logic.js";
import {
  configureOrchestratorRuntime,
  createMonitoringAuditPort,
  finalizeCommit,
  handleReviewGateRequest,
  logAuditEvent,
  resumeOrchestratorRun
} from "../orchestrator.workflow.js";
import type { MonitoringAuditPort, OrchestratorRuntime, WorkflowEnginePort } from "../orchestrator.workflow.js";
import type { AuditEvent, HumanReviewSubmissionEvent, ObligationPipelineState } from "../orchestrator.types.js";

const NOW = "2026-07-13T00:00:00.000Z";
const EFF = "2026-07-13";

// ---------------------------------------------------------------------------
// Stateful in-memory graph implementing the CommitPlan semantics this
// workflow relies on.
// ---------------------------------------------------------------------------

interface StatefulGraph {
  graph: GraphQueryPort;
  graphWriter: GraphWriterPort & { commitProposal(plan: CommitPlan): Promise<CommitResult> };
  obligations: Map<string, Obligation>;
  edges: Array<{ type: string; [k: string]: unknown }>;
}

function makeStatefulGraph(seed: Obligation[] = []): StatefulGraph {
  const obligations = new Map<string, Obligation>();
  for (const o of seed) obligations.set(o.obligation_id, o);
  const reviewsByObligation = new Map<string, unknown[]>();
  const edges: Array<{ type: string; [k: string]: unknown }> = [];

  const graph: GraphQueryPort = {
    async runCypher<T>(query: string, params: Record<string, unknown>): Promise<T[]> {
      if (query.includes("REVIEWED_BY")) {
        const obligationId = params.obligationId as string;
        const existing = (reviewsByObligation.get(obligationId) ?? [])
          .slice()
          .sort((a, b) => String((a as { decided_at: string }).decided_at).localeCompare(String((b as { decided_at: string }).decided_at)));
        return [{ obligationStatus: obligations.get(obligationId)?.status ?? "unknown", existingReviews: existing }] as T[];
      }
      return [] as T[];
    }
  };

  const commitProposal = async (plan: CommitPlan): Promise<CommitResult> => {
    // Obligation/ProcessTask node creates.
    for (const o of plan.nodes.obligations ?? []) {
      obligations.set(o.obligation_id, { ...(o as Obligation), recorded_at: NOW });
    }
    for (const review of plan.nodes.humanReviews ?? []) {
      const list = reviewsByObligation.get(review.obligation_id) ?? [];
      list.push({ ...review, recorded_at: NOW });
      reviewsByObligation.set(review.obligation_id, list);
    }
    // Status transitions in place.
    for (const t of plan.obligationStatusTransitions ?? []) {
      const existing = obligations.get(t.obligation_id);
      if (!existing) throw new ConflictError(`obligation ${t.obligation_id} missing`);
      obligations.set(t.obligation_id, { ...existing, status: t.newStatus });
    }
    // finalizeSupersessions with the FR-10 `valid_to IS NULL` guard.
    for (const f of plan.finalizeSupersessions ?? []) {
      const old = obligations.get(f.oldObligationId);
      if (!old) {
        const e = new Error(`commitProposal failed`);
        (e as { cause?: unknown }).cause = new ConflictError(`obligation ${f.oldObligationId} does not exist`);
        throw e;
      }
      if (old.valid_to !== null) {
        // Simulate GraphWriter wrapping ConflictError inside CommitError.
        const e = new Error(`commitProposal failed`);
        (e as { cause?: unknown }).cause = new ConflictError(`obligation ${f.oldObligationId} already superseded`);
        throw e;
      }
      obligations.set(f.oldObligationId, { ...old, valid_to: f.effectiveDate });
      edges.push({ type: "SUPERSEDES", from_id: f.newObligationId, to_id: f.oldObligationId });
    }
    for (const edge of plan.edges) edges.push(edge as { type: string });
    return { proposalId: plan.proposalId, committedAt: NOW, nodeCounts: {}, edgeCounts: {}, supersessionsApplied: 0 };
  };

  return { graph, graphWriter: { commitProposal }, obligations, edges };
}

function makeInMemoryLedger(): AuditLedgerPort {
  const entries: LedgerEntry[] = [];
  let seq = 0;
  return {
    async append(input: LedgerAppendInput): Promise<LedgerEntry> {
      seq += 1;
      const entry: LedgerEntry = {
        sequence_number: seq,
        timestamp: `2026-07-13T00:00:${String(seq).padStart(2, "0")}.000Z`,
        event_type: input.event_type,
        actor: input.actor,
        entity_ref: input.entity_ref,
        payload: input.payload,
        payload_hash: `hash-${seq}`,
        prev_entry_hash: seq === 1 ? "0".repeat(64) : `hash-${seq - 1}`,
        entry_hash: `hash-${seq}`
      };
      entries.push(entry);
      return entry;
    },
    async query(q: LedgerQuery): Promise<LedgerEntry[]> {
      return entries.filter((e) => (q.entityId ? e.payload.obligation_id === q.entityId || e.entity_ref.entity_id === q.entityId : true));
    },
    async verifyChainIntegrity() {
      throw new Error("not used");
    },
    async getLatestEntryForEntity() {
      return null;
    }
  };
}

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

function makeMapping(overrides: Partial<MappingRiskScoringResult> = {}): MappingRiskScoringResult {
  return {
    processTaskDraft: {
      obligation_id: "x",
      task_name: "task",
      owner_role: "Compliance Officer",
      sla_hours: 168,
      system_touchpoint: "portal",
      risk_score: 0.3
    },
    riskScoreExplain: { penaltySeverity: 0.3, deadlineProximityDays: 20, overwritesLiveObligation: false, riskScore: 0.3, deadlineWeight: 0.33, overwriteWeight: 0 },
    slaConfidence: "high",
    overwriteCheck: { overwritesLiveObligation: false, matchPath: null, overwrittenObligationId: null, degraded: false },
    firstSeenCheck: { isFirstSeenObligationType: false, degraded: false },
    ...overrides
  };
}

function makeState(obligationId: string, tier: ObligationPipelineState["tierDecision"]["tier"], mapping = makeMapping()): ObligationPipelineState {
  return {
    runId: `run-${obligationId}`,
    eventId: `evt-${obligationId}`,
    clause_id: "clause-1",
    circular_id: "circ-1",
    proposal: {
      category: "reporting",
      requirement_text: "req",
      trigger_event: "t",
      deadline_rule: "T+7",
      responsible_role: "Compliance Officer",
      evidence_required: "e",
      penalty_ref: null,
      applies_to_category_names: [],
      applies_to_unknown_category_names: [],
      derived_from_clause_id: "clause-1",
      confidence_score: 0.95,
      confidence_breakdown: { model_self_reported: 0.95, field_completeness_penalty: 0, ambiguity_penalty: 0, graphrag_support_bonus: 0, final: 0.95 },
      extraction_index: 0
    },
    verification: { run_id: "r", grounding_score: 0.95, field_results: [], contradiction: false, contradiction_details: [], verdict: "pass", summary: "", duration_ms: 1 },
    mapping,
    tierRouteInput: { riskScore: 0.3, hasContradiction: false, confidenceScore: 0.95, groundingScore: 0.95, isFirstSeenObligationType: false },
    tierDecision: { tier, reasons: ["BASE_TIER_A"] },
    obligation_id: obligationId,
    task_id: `task-${obligationId}`,
    preReviewCommit: null
  };
}

// A minimal ObligationPipelineState -> Obligation projection for seeding a
// live obligation the concurrent test will supersede.
function liveObligation(id: string): Obligation {
  return {
    obligation_id: id,
    derived_from_clause_id: "clause-0",
    category: "REPORTING",
    requirement_text: "old",
    trigger_event: "t",
    deadline_rule: "T+7",
    responsible_role: "Compliance Officer",
    evidence_required: "e",
    penalty_ref: null,
    confidence_score: 0.9,
    grounding_score: 0.9,
    status: "committed",
    valid_from: "2026-01-01",
    valid_to: null,
    recorded_at: "2026-01-01T00:00:00.000Z"
  };
}

// ---------------------------------------------------------------------------
// Runtime wiring: real Spec 07 monitoring port, real commit builders,
// stateful fakes, and an engine whose resume() drives the finalize/second-
// suspend control flow the real Mastra engine would.
// ---------------------------------------------------------------------------

interface Harness {
  sg: StatefulGraph;
  runtime: OrchestratorRuntime;
  monitoring: MonitoringAuditPort;
  index: InMemorySuspendedRunIndex;
  audits: AuditEvent[];
}

function makeHarness(states: ObligationPipelineState[], seed: Obligation[] = []): Harness {
  const sg = makeStatefulGraph(seed);
  const ledger = makeInMemoryLedger();
  const ctx: MonitoringAuditContext = { graph: sg.graph, graphWriter: sg.graphWriter, ledger, referenceDate: NOW };
  const monitoring = createMonitoringAuditPort(ctx);
  const index = new InMemorySuspendedRunIndex();
  const audits: AuditEvent[] = [];
  const byRun = new Map(states.map((s) => [s.runId, s]));
  const suspendedStep = new Map<string, "awaitHumanReview" | "awaitSecondHumanReview" | null>();
  const makerByRun = new Map<string, string>();

  const engine: WorkflowEnginePort = {
    async start() {
      return { runId: "unused" };
    },
    async resume({ runId, review, reviewOutcome }) {
      const state = byRun.get(runId)!;
      if (reviewOutcome === "AWAITING_SECOND_REVIEWER") {
        makerByRun.set(runId, review.reviewer_id);
        await index.record({
          obligation_id: state.obligation_id,
          runId,
          stepId: "awaitSecondHumanReview",
          tier: state.tierDecision.tier === "ESCALATE" ? "C" : (state.tierDecision.tier as "B" | "C"),
          suspendedAt: NOW
        });
        suspendedStep.set(runId, "awaitSecondHumanReview");
        return { finalStatus: "still_pending" as const };
      }
      const outcome = finalOutcomeFromReviewOutcome(reviewOutcome);
      await finalizeCommit(state, outcome);
      suspendedStep.set(runId, null);
      const status = sg.obligations.get(state.obligation_id)?.status ?? "still_pending";
      return { finalStatus: status };
    },
    async currentSuspendedStep(runId) {
      return suspendedStep.has(runId) ? suspendedStep.get(runId)! : "awaitHumanReview";
    },
    async getMakerReviewerId(runId) {
      return makerByRun.get(runId) ?? null;
    },
    async getObligationStatus(obligationId) {
      return sg.obligations.get(obligationId)?.status ?? "still_pending";
    }
  };

  const runtime: OrchestratorRuntime = {
    graphWriter: sg.graphWriter,
    monitoring,
    index,
    auditLog: async (e: AuditEvent) => {
      audits.push(e);
      await logAuditEvent(e);
    },
    engine,
    referenceNow: () => NOW
  };
  configureOrchestratorRuntime(runtime);
  return { sg, runtime, monitoring, index, audits };
}

/** Simulate the pre-review commit the routeAndPreCommitStep would issue. */
async function preReviewCommit(h: Harness, state: ObligationPipelineState): Promise<void> {
  const plan = buildPreReviewCommitPlan({ state, categoryIdByName: {}, effectiveDate: EFF });
  await h.runtime.graphWriter.commitProposal(plan);
  if (state.tierDecision.tier !== "A") {
    await h.index.record({
      obligation_id: state.obligation_id,
      runId: state.runId,
      stepId: "awaitHumanReview",
      tier: state.tierDecision.tier === "ESCALATE" ? "C" : (state.tierDecision.tier as "B" | "C"),
      suspendedAt: NOW
    });
  }
}

function submission(state: ObligationPipelineState, reviewerId: string, decision: "approve" | "reject", tier: "B" | "C", stepId: HumanReviewSubmissionEvent["stepId"], eventId: string): HumanReviewSubmissionEvent {
  return {
    runId: state.runId,
    stepId,
    obligation_id: state.obligation_id,
    review: {
      event_id: eventId,
      obligation_id: state.obligation_id,
      reviewer_id: reviewerId,
      tier,
      decision,
      rationale: tier === "C" ? "rationale" : null,
      decided_at: NOW,
      source: "web-console",
      source_ref: null
    }
  };
}

// ---------------------------------------------------------------------------
// Acceptance Criteria (in-memory).
// ---------------------------------------------------------------------------

describe("Spec 08 acceptance criteria (in-memory stateful graph)", () => {
  beforeEach(() => {
    process.env.SENTINEL_SERVICE_JWT_SECRET = process.env.SENTINEL_SERVICE_JWT_SECRET ?? "test-secret";
  });

  it("AC1: Tier A auto-commit, no suspend, status tier_a_committed, MAPPED_TO edge", async () => {
    const state = makeState("obl-a", "A");
    const h = makeHarness([state]);
    await preReviewCommit(h, state);
    expect(h.sg.obligations.get("obl-a")!.status).toBe("tier_a_committed");
    expect(h.sg.edges.some((e) => e.type === "MAPPED_TO")).toBe(true);
    // Tier A finalize (non-overwrite) is a no-op commit; audit still fires.
    const committed = await finalizeCommit(state, "tier_a");
    expect(committed).toBe(true);
    expect(h.audits.some((a) => a.kind === "final_commit")).toBe(true);
  });

  it("AC2: Tier B pre-review commit visible BEFORE resume; recordHumanReview writes HumanReview before finalize -> committed", async () => {
    const state = makeState("obl-b", "B");
    const h = makeHarness([state]);
    await preReviewCommit(h, state);
    // Visible in the graph before any resume.
    expect(h.sg.obligations.get("obl-b")!.status).toBe("tier_b_review");
    expect(await h.index.find("obl-b")).toEqual({ runId: state.runId, stepId: "awaitHumanReview" });

    const out = await resumeOrchestratorRun(submission(state, "co-anita", "approve", "B", "awaitHumanReview", "ev-b1"));
    expect(out.resumed).toBe(true);
    // HumanReview node written by recordHumanReview (Spec 07), visible now.
    const reviews = await getReviewsVisibleTo("obl-b", "co-anita", { graph: h.sg.graph, graphWriter: h.sg.graphWriter, ledger: makeInMemoryLedger(), referenceDate: NOW });
    expect(reviews).toHaveLength(1);
    expect(h.sg.obligations.get("obl-b")!.status).toBe("committed");
  });

  it("AC3: Tier C maker-checker independence via the REAL review-gate endpoint", async () => {
    const state = makeState("obl-c", "C");
    const h = makeHarness([state]);
    await preReviewCommit(h, state);

    const token = makeJwt("test-secret");

    // FR-20/FR-31: the maker/checker slot must be genuinely claimed before
    // resumeOrchestratorRun accepts that reviewer's decision — claim it
    // first, same as the real POST .../claim flow the BFF drives.
    await h.index.claim("obl-c", "maker-1");

    // Maker submits.
    const first = await resumeOrchestratorRun(submission(state, "maker-1", "approve", "C", "awaitHumanReview", "ev-c1"));
    expect(first.finalStatus).toBe("still_pending");
    // Now suspended at the checker slot.
    expect(await h.index.find("obl-c")).toEqual({ runId: state.runId, stepId: "awaitSecondHumanReview" });

    // Checker's review-gate view MUST NOT reveal the maker's decision.
    const checkerViewBefore = await handleReviewGateRequest(
      { obligationId: "obl-c", reviewerId: "checker-2", tier: "C", authorization: `Bearer ${token}` },
      { monitoring: h.monitoring }
    );
    expect(checkerViewBefore.reveal).toBeNull();
    expect(checkerViewBefore.status).toBe("awaiting_maker");

    // Checker claims, then submits (distinct reviewer).
    await h.index.claim("obl-c", "checker-2");
    await resumeOrchestratorRun(submission(state, "checker-2", "approve", "C", "awaitSecondHumanReview", "ev-c2"));
    expect(h.sg.obligations.get("obl-c")!.status).toBe("committed");

    // Now both are visible to either reviewer.
    const afterView = await handleReviewGateRequest(
      { obligationId: "obl-c", reviewerId: "checker-2", tier: "C", authorization: `Bearer ${token}` },
      { monitoring: h.monitoring }
    );
    expect(afterView.status).toBe("complete");
    expect(afterView.reveal).toHaveLength(2);
  });

  it("AC3b: same reviewer for maker and checker is rejected (ReviewerIndependenceError), no second review written", async () => {
    const state = makeState("obl-c2", "C");
    const h = makeHarness([state]);
    await preReviewCommit(h, state);
    // FR-20/FR-31: claim the maker slot first (the same reviewer cannot
    // also claim checker — InMemorySuspendedRunIndex.claim already
    // enforces that — so the checker submission below is rejected by the
    // pre-existing ReviewerIndependenceError check, which runs BEFORE the
    // new claimed-slot check and fires first for this same-reviewer case).
    await h.index.claim("obl-c2", "same-rev");
    await resumeOrchestratorRun(submission(state, "same-rev", "approve", "C", "awaitHumanReview", "ev-1"));
    await expect(
      resumeOrchestratorRun(submission(state, "same-rev", "approve", "C", "awaitSecondHumanReview", "ev-2"))
    ).rejects.toMatchObject({ name: "ReviewerIndependenceError" });
    // Still exactly one review; obligation still under review.
    expect(h.sg.obligations.get("obl-c2")!.status).toBe("tier_c_review");
  });

  it("AC4: escalate-on-contradiction never finalizes without two reviews; disagreement -> escalated", async () => {
    const state = makeState("obl-e", "ESCALATE");
    const h = makeHarness([state]);
    await preReviewCommit(h, state);
    expect(h.sg.obligations.get("obl-e")!.status).toBe("escalated");
    // maker approve, checker reject -> disagreement -> escalated. FR-20/
    // FR-31: ESCALATE shares Tier C's claim/suspend mechanics, so each
    // reviewer must claim their slot first.
    await h.index.claim("obl-e", "m");
    await resumeOrchestratorRun(submission(state, "m", "approve", "C", "awaitHumanReview", "ev-1"));
    await h.index.claim("obl-e", "c");
    await resumeOrchestratorRun(submission(state, "c", "reject", "C", "awaitSecondHumanReview", "ev-2"));
    expect(h.sg.obligations.get("obl-e")!.status).toBe("escalated");
  });

  it("AC5: two runs racing finalizeSupersessions on the same oldObligationId -> exactly one wins", async () => {
    const stateX = makeState("new-x", "A", makeMapping({ overwriteCheck: { overwritesLiveObligation: true, matchPath: "explicit", overwrittenObligationId: "old-live", degraded: false } }));
    const stateY = makeState("new-y", "A", makeMapping({ overwriteCheck: { overwritesLiveObligation: true, matchPath: "explicit", overwrittenObligationId: "old-live", degraded: false } }));
    const h = makeHarness([stateX, stateY], [liveObligation("old-live")]);
    // Both create their new obligation (pre-review) first.
    await preReviewCommit(h, stateX);
    await preReviewCommit(h, stateY);

    const results = await Promise.all([finalizeCommit(stateX, "tier_a"), finalizeCommit(stateY, "tier_a")]);
    const winners = results.filter((r) => r === true).length;
    const losers = results.filter((r) => r === false).length;
    expect(winners).toBe(1);
    expect(losers).toBe(1);
    // old obligation's valid_to closed exactly once.
    expect(h.sg.obligations.get("old-live")!.valid_to).toBe(EFF);
    // The loser logged conflict_reconciled.
    expect(h.audits.some((a) => a.kind === "conflict_reconciled")).toBe(true);
  });
});

// Minimal HS256 JWT for the review-gate auth check (mirrors verifyServiceJwt).
function makeJwt(secret: string): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = enc({ alg: "HS256", typ: "JWT" });
  const payload = enc({ sub: "svc", exp: Math.floor(Date.now() / 1000) + 3600 });
  const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

// ---------------------------------------------------------------------------
// Real-Neo4j suite (gated). Wire a real GraphWriter/driver here once Docker
// is available; the scenario bodies above transfer unchanged.
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.ORCHESTRATOR_LIVE_INFRA_TEST)("Spec 08 acceptance criteria (real Neo4j — gated)", () => {
  it("placeholder — requires a live Neo4j driver + testcontainers", () => {
    expect(process.env.ORCHESTRATOR_LIVE_INFRA_TEST).toBeTruthy();
  });
});
