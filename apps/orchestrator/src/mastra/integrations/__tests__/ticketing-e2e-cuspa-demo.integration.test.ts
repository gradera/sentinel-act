// Spec 13 §10's end-to-end (demo rehearsal) test: "reuses the same CUSPA
// Paragraph 46 amendment fixture Spec 08's own end-to-end test drives ...
// running the real startOrchestratorRun through to a Tier C maker-checker
// approval, with the FR-2 hook wired to a real (test) webhook receiver,
// asserting a ticket is created end to end with the exact field mapping
// this spec defines."
//
// Convention note (mirrors cuspa-tier-c-review-audit-trail.integration.test.ts's
// own header comment exactly, plus orchestrator.workflow.integration.test.ts's
// AC3 test): no Docker is available in this sandbox, and the 5 fanned-out
// agents (extraction/grounding/mapping/change/monitoring) that
// startOrchestratorRun's real fan-out would invoke are LLM-backed and
// require live model credentials this sandbox does not have — the same
// reason no test file in this repo actually drives the full fan-out
// end-to-end. This file follows the established, already-working
// convention instead: an ObligationPipelineState is constructed directly
// for the canonical "ob-cuspa-para-46-live" fixture
// (cuspa-tier-c-review-audit-trail.integration.test.ts's own naming
// convention), then driven through the REAL resumeOrchestratorRun ->
// finalizeCommit (Spec 08's actual, unmocked functions — the same
// functions orchestrator.workflow.integration.test.ts's AC3 test
// exercises for Tier C) to a genuine Tier C maker-checker approval, with
// the REAL Spec 13 hook (createTicketingTriggerPort) wired into
// OrchestratorRuntime.ticketing, a REAL GenericWebhookAdapter making a
// REAL signed HTTP call to a REAL in-process receiver (Node's http
// module, matching Spec 13 §10's own "fake in-process HTTP receiver"
// wording), and the REAL handleObligationCommittedEvent/processOutboxOnce
// pipeline. Only the LLM-backed proposal/verification/mapping outputs are
// pre-baked as fixture data rather than freshly generated — this is a
// scope choice already established for this fixture elsewhere in this
// repo, not a new corner cut for this spec.
import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import type { CommitPlan, CommitResult } from "@sentinel-act/graph-db";
import { ConflictError } from "@sentinel-act/graph-db";
import type { Obligation, ProcessTask } from "@sentinel-act/graph-schema";
import type { AuditLedgerPort, LedgerAppendInput, LedgerEntry, LedgerQuery } from "@sentinel-act/audit-ledger";
import {
  createMonitoringAuditPort,
  configureOrchestratorRuntime,
  finalizeCommit,
  resumeOrchestratorRun
} from "../../workflows/orchestrator.workflow.js";
import type { MonitoringAuditPort, OrchestratorRuntime, WorkflowEnginePort } from "../../workflows/orchestrator.workflow.js";
import { buildPreReviewCommitPlan, finalOutcomeFromReviewOutcome, InMemorySuspendedRunIndex } from "../../workflows/orchestrator.logic.js";
import type { ObligationPipelineState } from "../../workflows/orchestrator.types.js";
import type { GraphQueryPort as MonitoringGraphQueryPort, GraphWriterPort, MonitoringAuditContext } from "../../agents/monitoring-and-audit.agent.js";
import { GenericWebhookAdapter, processOutboxOnce } from "@sentinel-act/ticketing-adapter";
import type { AppendLedgerEntryPort, GraphQueryPort, TicketingContext, TicketingOutboxEntry, TicketingOutboxPort, TicketMapping } from "@sentinel-act/ticketing-adapter";
import { createTicketingTriggerPort } from "../grc-ticketing.js";

const NOW = "2026-07-13T00:00:00.000Z";
const EFF = "2026-07-13";

const OBLIGATION_ID = "ob-cuspa-para-46-live";
const TASK_ID = "task-cuspa-para-46-live";

// ---------------------------------------------------------------------------
// The CUSPA Paragraph 46 fixture — merges the field values already
// established across mapping-risk-scoring.agent.test.ts's "ob-cuspa-
// para46" fixture and grounding-verification.integration.test.ts's
// "ob-cuspa-para-46-live" variant into one consistent Obligation/
// ProcessTask pair for this end-to-end scenario.
// ---------------------------------------------------------------------------

function makeCuspaObligation(): Obligation {
  return {
    obligation_id: OBLIGATION_ID,
    derived_from_clause_id: "clause-cuspa-para-46",
    category: "risk_management",
    requirement_text:
      "Client unpaid securities may be retained by the stock broker only in a designated client unpaid securities account, and may additionally be auto-pledged by the client solely for meeting the client's own funding obligations.",
    trigger_event: "unpaid securities beyond T+2 working days",
    deadline_rule: "within T+2 working days of the trigger event",
    responsible_role: "Compliance Officer",
    evidence_required: "signed client unpaid securities account (CUSPA) confirmation",
    penalty_ref: "Monetary penalty of ₹15,00,000 as per Section 15HB for non-compliance",
    confidence_score: 0.92,
    grounding_score: 0.95,
    status: "tier_c_review",
    valid_from: EFF,
    valid_to: null,
    recorded_at: NOW
  };
}

function makeCuspaTask(): ProcessTask {
  return {
    task_id: TASK_ID,
    obligation_id: OBLIGATION_ID,
    task_name: "Transfer client unpaid securities to the designated CUSPA account",
    owner_role: "Compliance Officer",
    sla_hours: 48, // T+2 working days
    system_touchpoint: "back-office securities ledger",
    risk_score: 0.85, // penalty-bearing + overwrites a live obligation -> Tier C
    valid_from: NOW,
    valid_to: null,
    recorded_at: NOW
  };
}

function makeCuspaState(): ObligationPipelineState {
  return {
    runId: "run-cuspa-para-46",
    eventId: "evt-cuspa-para-46",
    clause_id: "clause-cuspa-para-46",
    circular_id: "circ-cuspa-1",
    proposal: {
      category: "risk_management",
      requirement_text: makeCuspaObligation().requirement_text,
      trigger_event: makeCuspaObligation().trigger_event,
      deadline_rule: makeCuspaObligation().deadline_rule,
      responsible_role: "Compliance Officer",
      evidence_required: makeCuspaObligation().evidence_required,
      penalty_ref: makeCuspaObligation().penalty_ref,
      applies_to_category_names: ["Stockbroker"],
      applies_to_unknown_category_names: [],
      derived_from_clause_id: "clause-cuspa-para-46",
      confidence_score: 0.92,
      confidence_breakdown: { model_self_reported: 0.92, field_completeness_penalty: 0, ambiguity_penalty: 0, graphrag_support_bonus: 0, final: 0.92 },
      extraction_index: 0
    } as ObligationPipelineState["proposal"],
    verification: {
      run_id: "run-cuspa-para-46",
      grounding_score: 0.95,
      field_results: [],
      contradiction: true, // CUSPA Para 46 overwrites a live obligation — routes to Tier C
      contradiction_details: [{ note: "overwrites a live obligation (CUSPA Para 46)" } as never],
      verdict: "pass",
      summary: "grounded, contradiction against a live obligation",
      duration_ms: 5
    } as ObligationPipelineState["verification"],
    mapping: {
      processTaskDraft: {
        obligation_id: OBLIGATION_ID,
        task_name: makeCuspaTask().task_name,
        owner_role: "Compliance Officer",
        sla_hours: 48,
        system_touchpoint: "back-office securities ledger",
        risk_score: 0.85
      },
      riskScoreExplain: { penaltySeverity: 0.9, deadlineProximityDays: 2, overwritesLiveObligation: false, riskScore: 0.85, deadlineWeight: 0.93, overwriteWeight: 0 },
      slaConfidence: "high",
      overwriteCheck: { overwritesLiveObligation: false, matchPath: null, overwrittenObligationId: null, degraded: false },
      firstSeenCheck: { isFirstSeenObligationType: false, degraded: false }
    } as ObligationPipelineState["mapping"],
    tierRouteInput: { riskScore: 0.85, hasContradiction: true, confidenceScore: 0.92, groundingScore: 0.95, isFirstSeenObligationType: false },
    tierDecision: { tier: "C", reasons: ["CONTRADICTION"] },
    obligation_id: OBLIGATION_ID,
    task_id: TASK_ID,
    preReviewCommit: null
  };
}

// ---------------------------------------------------------------------------
// Combined stateful fake graph — serves BOTH Spec 07's monitoring-and-
// audit REVIEWED_BY query shape (recordHumanReview/getReviewsVisibleTo,
// via MonitoringGraphQueryPort) AND Spec 13's BUILD_TICKET_LINEAGE_CYPHER
// shape (buildCreateTicketRequest, via ticketing's GraphQueryPort) from
// one shared in-memory Obligation/ProcessTask state — mirroring
// orchestrator.workflow.integration.test.ts's makeStatefulGraph pattern,
// extended with the lineage query this spec adds.
// ---------------------------------------------------------------------------

interface StatefulCuspaGraph {
  monitoringGraph: MonitoringGraphQueryPort;
  ticketingGraph: GraphQueryPort;
  graphWriter: GraphWriterPort & { commitProposal(plan: CommitPlan): Promise<CommitResult> };
  obligations: Map<string, Obligation>;
}

function makeStatefulCuspaGraph(): StatefulCuspaGraph {
  const obligations = new Map<string, Obligation>([[OBLIGATION_ID, makeCuspaObligation()]]);
  const reviewsByObligation = new Map<string, unknown[]>();
  const task = makeCuspaTask();
  const lineage = { clauseParaRef: "46", circularTitle: "CUSPA Circular", circularDateEffective: "2026-07-03", circularId: "circ-cuspa-1" };

  const monitoringGraph: MonitoringGraphQueryPort = {
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

  const ticketingGraph: GraphQueryPort = {
    async runCypher<T>(query: string): Promise<T[]> {
      if (query.includes("DERIVED_FROM")) {
        const obligation = obligations.get(OBLIGATION_ID)!;
        return [{ o: obligation, t: task, ...lineage }] as unknown as T[];
      }
      return [] as T[];
    }
  };

  const commitProposal = async (plan: CommitPlan): Promise<CommitResult> => {
    for (const review of plan.nodes.humanReviews ?? []) {
      const list = reviewsByObligation.get(review.obligation_id) ?? [];
      list.push({ ...review, recorded_at: NOW });
      reviewsByObligation.set(review.obligation_id, list);
    }
    for (const t of plan.obligationStatusTransitions ?? []) {
      const existing = obligations.get(t.obligation_id);
      if (!existing) throw new ConflictError(`obligation ${t.obligation_id} missing`);
      obligations.set(t.obligation_id, { ...existing, status: t.newStatus });
    }
    return { proposalId: plan.proposalId, committedAt: NOW, nodeCounts: {}, edgeCounts: {}, supersessionsApplied: 0 };
  };

  return { monitoringGraph, ticketingGraph, graphWriter: { commitProposal }, obligations };
}

function makeInMemoryMonitoringLedger(): AuditLedgerPort {
  const entries: LedgerEntry[] = [];
  let seq = 0;
  return {
    async append(input: LedgerAppendInput): Promise<LedgerEntry> {
      seq += 1;
      const entry: LedgerEntry = {
        sequence_number: seq,
        timestamp: NOW,
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
// Minimal in-memory TicketingOutboxPort (same CAS/uniqueness semantics as
// grc-ticketing.integration.test.ts's InMemoryTicketingOutboxPort).
// ---------------------------------------------------------------------------

class InMemoryTicketingOutboxPort implements TicketingOutboxPort {
  private readonly entries = new Map<string, TicketingOutboxEntry>();
  private readonly mappings = new Map<string, TicketMapping>();
  private readonly eventIds = new Set<string>();
  private clockCounter = 0;

  private tick(): string {
    const ts = new Date(new Date("2000-01-01T00:00:00.000Z").getTime() + this.clockCounter).toISOString();
    this.clockCounter += 1;
    return ts;
  }

  async insertIfNotExists(entry: Omit<TicketingOutboxEntry, "status" | "attempts" | "next_attempt_at" | "last_error" | "created_at" | "updated_at">): Promise<{ inserted: boolean }> {
    if (this.eventIds.has(entry.event_id)) return { inserted: false };
    this.eventIds.add(entry.event_id);
    const ts = this.tick();
    this.entries.set(entry.id, { ...entry, status: "pending", attempts: 0, next_attempt_at: ts, last_error: null, created_at: ts, updated_at: ts });
    return { inserted: true };
  }
  async claimBatch(limit: number, now: string): Promise<TicketingOutboxEntry[]> {
    const candidates = [...this.entries.values()]
      .filter((e) => (e.status === "pending" || e.status === "failed_retryable") && e.next_attempt_at <= now)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(0, limit);
    const claimed: TicketingOutboxEntry[] = [];
    for (const c of candidates) {
      const fresh = this.entries.get(c.id);
      if (fresh && (fresh.status === "pending" || fresh.status === "failed_retryable")) {
        fresh.status = "processing";
        claimed.push({ ...fresh });
      }
    }
    return claimed;
  }
  async markSucceeded(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (e) e.status = "succeeded";
  }
  async markRetryable(id: string, nextAttemptAt: string, error: string): Promise<void> {
    const e = this.entries.get(id);
    if (e) {
      e.status = "failed_retryable";
      e.attempts += 1;
      e.next_attempt_at = nextAttemptAt;
      e.last_error = error;
    }
  }
  async markPermanentFailure(id: string, error: string): Promise<void> {
    const e = this.entries.get(id);
    if (e) {
      e.status = "failed_permanent";
      e.attempts += 1;
      e.last_error = error;
    }
  }
  async resetToPending(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (e) {
      e.status = "pending";
      e.attempts = 0;
      e.last_error = null;
      e.next_attempt_at = this.tick();
    }
  }
  async findMapping(task_id: string): Promise<TicketMapping | null> {
    return this.mappings.get(task_id) ?? null;
  }
  async insertMapping(mapping: TicketMapping): Promise<{ inserted: boolean }> {
    if (this.mappings.has(mapping.task_id)) return { inserted: false };
    this.mappings.set(mapping.task_id, mapping);
    return { inserted: true };
  }
  async hasInFlightEntryForTask(task_id: string): Promise<boolean> {
    return [...this.entries.values()].some((e) => e.task_id === task_id && (e.status === "pending" || e.status === "processing" || e.status === "failed_retryable"));
  }
}

function makeInMemoryTicketingLedger(): AppendLedgerEntryPort & { calls: Array<Parameters<AppendLedgerEntryPort["append"]>[0]> } {
  const calls: Array<Parameters<AppendLedgerEntryPort["append"]>[0]> = [];
  let seq = 0;
  return {
    calls,
    async append(input) {
      seq += 1;
      calls.push(input);
      return { sequence_number: seq };
    }
  };
}

// ---------------------------------------------------------------------------
// Real in-process HTTP receiver.
// ---------------------------------------------------------------------------

class FakeWebhookReceiver {
  private server: Server | null = null;
  url = "";
  readonly requests: Array<{ body: string; signature: string | undefined }> = [];

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        this.requests.push({ body, signature: req.headers["x-sentinel-signature"] as string | undefined });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ externalId: "jira-CUSPA-46", externalUrl: "https://tickets.example/jira-CUSPA-46" }));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    this.url = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server!.close((err) => (err ? reject(err) : resolve())));
  }
}

// ---------------------------------------------------------------------------
// The end-to-end scenario.
// ---------------------------------------------------------------------------

describe("ticketing-e2e-cuspa-demo: Tier C maker-checker approval -> real ticketing pipeline -> real webhook receiver", () => {
  it("produces exactly one ticket whose fields match Spec 13's mapping rules exactly, tied to the CUSPA Paragraph 46 flagship fixture", async () => {
    const receiver = new FakeWebhookReceiver();
    await receiver.start();
    try {
      const sg = makeStatefulCuspaGraph();
      const monitoringLedger = makeInMemoryMonitoringLedger();
      const monitoringCtx: MonitoringAuditContext = { graph: sg.monitoringGraph, graphWriter: sg.graphWriter, ledger: monitoringLedger, referenceDate: NOW };
      const monitoring: MonitoringAuditPort = createMonitoringAuditPort(monitoringCtx);
      const index = new InMemorySuspendedRunIndex();

      const ticketingOutbox = new InMemoryTicketingOutboxPort();
      const ticketingLedger = makeInMemoryTicketingLedger();
      const ticketingCtx: TicketingContext = {
        graph: sg.ticketingGraph,
        adapter: new GenericWebhookAdapter({ url: receiver.url, secret: "cuspa-demo-secret" }),
        roleAssigneeMap: { resolve: async (role) => (role === "Compliance Officer" ? { externalAssigneeRef: "queue:compliance-ops", displayLabel: "Compliance Officer", isFallback: false } : null) },
        outbox: ticketingOutbox,
        ledger: ticketingLedger,
        referenceDate: NOW,
        config: { defaultAssigneeRef: "queue:unassigned", maxAttempts: 8, baseBackoffMs: 60_000, maxBackoffMs: 21_600_000, outboxBatchSize: 20 }
      };

      const state = makeCuspaState();
      const suspendedStepByRun = new Map<string, "awaitHumanReview" | "awaitSecondHumanReview" | null>();
      const makerByRun = new Map<string, string>();

      const engine: WorkflowEnginePort = {
        async start() {
          return { runId: "unused" };
        },
        async resume({ runId, review, reviewOutcome }) {
          if (reviewOutcome === "AWAITING_SECOND_REVIEWER") {
            makerByRun.set(runId, review.reviewer_id);
            await index.record({ obligation_id: state.obligation_id, runId, stepId: "awaitSecondHumanReview", tier: "C", suspendedAt: NOW });
            suspendedStepByRun.set(runId, "awaitSecondHumanReview");
            return { finalStatus: "still_pending" as const };
          }
          const outcome = finalOutcomeFromReviewOutcome(reviewOutcome);
          await finalizeCommit(state, outcome);
          suspendedStepByRun.set(runId, null);
          return { finalStatus: sg.obligations.get(state.obligation_id)?.status ?? "still_pending" };
        },
        async currentSuspendedStep(runId) {
          return suspendedStepByRun.has(runId) ? suspendedStepByRun.get(runId)! : "awaitHumanReview";
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
        auditLog: async () => undefined,
        engine,
        referenceNow: () => NOW,
        ticketing: createTicketingTriggerPort(ticketingCtx)
      };
      configureOrchestratorRuntime(runtime);

      // Pre-review commit: sets status to tier_c_review and records the
      // suspended run at the maker slot (mirroring routeAndPreCommitStep +
      // awaitHumanReviewStep for a Tier C branch).
      const preReviewPlan = buildPreReviewCommitPlan({ state, categoryIdByName: {}, effectiveDate: EFF });
      await sg.graphWriter.commitProposal(preReviewPlan);
      await index.record({ obligation_id: state.obligation_id, runId: state.runId, stepId: "awaitHumanReview", tier: "C", suspendedAt: NOW });
      expect(sg.obligations.get(OBLIGATION_ID)!.status).toBe("tier_c_review");

      // FR-20/FR-31: the maker/checker slot must be genuinely claimed
      // before resumeOrchestratorRun accepts that reviewer's decision —
      // same as the real POST .../claim flow the BFF drives (mirrors
      // orchestrator.workflow.integration.test.ts's AC3 harness).
      await index.claim(state.obligation_id, "reviewer-maker");

      // Maker approves.
      const makerResult = await resumeOrchestratorRun({
        runId: state.runId,
        stepId: "awaitHumanReview",
        obligation_id: state.obligation_id,
        review: {
          event_id: "event-maker-cuspa",
          obligation_id: state.obligation_id,
          reviewer_id: "reviewer-maker",
          tier: "C",
          decision: "approve",
          rationale: "meets requirement per CUSPA Paragraph 46",
          decided_at: NOW,
          source: "web-console",
          source_ref: null
        }
      });
      expect(makerResult.finalStatus).toBe("still_pending");

      await index.claim(state.obligation_id, "reviewer-checker");

      // Checker independently approves -> Tier C maker-checker approval,
      // finalizeCommit fires, the Spec 13 hook enqueues, and (since no
      // background poll loop runs in a test) processOutboxOnce is called
      // explicitly to drain it — exactly what the real 30s poll loop would
      // do on its next tick.
      const checkerResult = await resumeOrchestratorRun({
        runId: state.runId,
        stepId: "awaitSecondHumanReview",
        obligation_id: state.obligation_id,
        review: {
          event_id: "event-checker-cuspa",
          obligation_id: state.obligation_id,
          reviewer_id: "reviewer-checker",
          tier: "C",
          decision: "approve",
          rationale: "independently confirmed against CUSPA Paragraph 46",
          decided_at: NOW,
          source: "slack",
          source_ref: null
        }
      });
      expect(checkerResult.finalStatus).toBe("committed");

      const outboxResult = await processOutboxOnce(ticketingCtx);
      expect(outboxResult).toEqual({ processed: 1, succeeded: 1, failedRetryable: 0, failedPermanent: 0 });

      // ---- Assert the ticket produced end to end matches FR-5..FR-12 exactly. ----
      expect(receiver.requests).toHaveLength(1);
      const sentBody = JSON.parse(receiver.requests[0].body);

      expect(sentBody.dedupeKey).toBe(TASK_ID); // FR-5
      expect(sentBody.title).toBe("Transfer client unpaid securities to the designated CUSPA account"); // FR-6, verbatim
      expect(sentBody.description).toContain("**Requirement:** Client unpaid securities may be retained"); // FR-7
      expect(sentBody.description).toContain("**Deadline rule:** within T+2 working days of the trigger event");
      expect(sentBody.description).toContain("**Evidence required:** signed client unpaid securities account");
      expect(sentBody.description).toContain("**Penalty:** Monetary penalty of ₹15,00,000");
      expect(sentBody.description).toContain("**Source:** CUSPA Circular, effective 2026-07-03, para 46");
      expect(sentBody.assignee).toEqual({ externalAssigneeRef: "queue:compliance-ops", displayLabel: "Compliance Officer", isFallback: false }); // FR-8
      expect(sentBody.dueDate).toBe(new Date(new Date(NOW).getTime() + 48 * 60 * 60 * 1000).toISOString()); // FR-10
      expect(sentBody.priority).toBe("P1_urgent"); // FR-11, risk_score 0.85 >= 0.75
      expect(sentBody.labels).toEqual(["sentinel-act", "tier:C", "category:risk_management"]); // FR-12
      expect(sentBody.sourceRefs).toEqual({ obligation_id: OBLIGATION_ID, task_id: TASK_ID, circular_id: "circ-cuspa-1", clause_para_ref: "46" });
      expect(receiver.requests[0].signature).toMatch(/^sha256=[0-9a-f]{64}$/);

      const mapping = await ticketingOutbox.findMapping(TASK_ID);
      expect(mapping?.external_ticket_id).toBe("jira-CUSPA-46");
      expect(ticketingLedger.calls).toHaveLength(1);
      expect(ticketingLedger.calls[0].event_type).toBe("TICKET_CREATED");
    } finally {
      await receiver.stop();
    }
  });
});
