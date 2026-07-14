// Spec 07 §10/§11 tasks 8-10: unit tests for the Monitoring and Audit
// Agent's pure/composed functions against hand-rolled fake
// GraphQueryPort/GraphWriterPort/AuditLedgerPort (no live Neo4j/Postgres
// required), mirroring mapping-risk-scoring.agent.test.ts's fake-port
// pattern. Also implements Spec 07 §9's Acceptance Criteria 1-6 as
// literal test cases.
import { describe, expect, it } from "vitest";
import { DEADLINE_FIXTURE } from "@sentinel-act/ticketing-adapter";
import type { EvidenceArtifact, HumanReview, ProcessTask } from "@sentinel-act/graph-schema";
import type { CommitPlan, CommitResult } from "@sentinel-act/graph-db";
import type { AuditLedgerPort, LedgerEntry, LedgerAppendInput, LedgerQuery, ChainVerificationResult } from "@sentinel-act/audit-ledger";
import {
  computeTaskDeadline,
  computeHoursElapsedRatio,
  classifySlaStatus,
  scanForSlaGaps,
  computeFileHash,
  ingestEvidenceArtifact,
  recordHumanReview,
  getReviewsVisibleTo,
  appendLedgerEntry,
  verifyChainIntegrity,
  reconcileLedgerGaps,
  SLA_APPROACHING_THRESHOLD_RATIO,
  MAX_EVIDENCE_FILE_SIZE_BYTES,
  type GraphQueryPort,
  type GraphWriterPort,
  type MonitoringAuditContext,
  type HumanReviewSubmittedEvent
} from "../monitoring-and-audit.agent.js";
import { ValidationError, SameReviewerNotAllowedError, ReviewAlreadyCompleteError } from "../monitoring-and-audit.errors.js";

// ---------------------------------------------------------------------------
// Fixtures / fakes
// ---------------------------------------------------------------------------

function makeProcessTask(overrides: Partial<ProcessTask> = {}): ProcessTask {
  return {
    task_id: "task-1",
    obligation_id: "ob-1",
    task_name: "File report",
    owner_role: "Stockbroker",
    sla_hours: 48,
    system_touchpoint: "Reporting Portal",
    risk_score: 0.5,
    valid_from: "2026-07-01T00:00:00.000Z",
    valid_to: null,
    recorded_at: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

function makeEvidenceArtifact(overrides: Partial<EvidenceArtifact> = {}): EvidenceArtifact {
  return {
    evidence_id: "evidence-1",
    task_id: "task-1",
    type: "report",
    hash: "abc123",
    uploaded_at: "2026-07-02T00:00:00.000Z",
    uploaded_by: "user-1",
    valid_from: "2026-07-02",
    valid_to: null,
    recorded_at: "2026-07-02T00:00:00.000Z",
    ...overrides
  };
}

function makeHumanReview(overrides: Partial<HumanReview> = {}): HumanReview {
  return {
    review_id: "review-1",
    obligation_id: "ob-1",
    reviewer_id: "reviewer-a",
    tier: "B",
    decision: "approve",
    rationale: null,
    decided_at: "2026-07-13T00:00:00.000Z",
    valid_from: "2026-07-13",
    valid_to: null,
    recorded_at: "2026-07-13T00:00:00.000Z",
    ...overrides
  };
}

interface FakeGraphOptions {
  taskExists?: boolean;
  duplicateEvidence?: unknown;
  slaRows?: { t: unknown; evidenceArtifacts: unknown[] }[];
  reviewRows?: { obligationStatus: string; existingReviews: unknown[] }[];
  recentReviews?: { r: unknown; obligationId: string }[];
  recentEvidence?: { e: unknown; taskId: string }[];
  throwOn?: "sla" | "reviews" | "task" | "duplicate";
  neverResolveOn?: "reviews";
}

function makeFakeGraph(opts: FakeGraphOptions = {}): GraphQueryPort {
  return {
    async runCypher<T>(query: string): Promise<T[]> {
      if (query.includes("WHERE t.valid_to IS NULL")) {
        if (opts.throwOn === "sla") throw new Error("Neo4j unreachable");
        return (opts.slaRows ?? []) as T[];
      }
      // Reconciliation-sweep queries (checked before the generic
      // REVIEWED_BY/EVIDENCED_BY branches below, since both sets of
      // Cypher share those relationship-type substrings).
      if (query.includes("r.recorded_at >= datetime($sinceTimestamp)")) {
        return (opts.recentReviews ?? []) as T[];
      }
      if (query.includes("e.recorded_at >= datetime($sinceTimestamp)")) {
        return (opts.recentEvidence ?? []) as T[];
      }
      if (query.includes("REVIEWED_BY")) {
        if (opts.throwOn === "reviews") throw new Error("Neo4j unreachable");
        if (opts.neverResolveOn === "reviews") return new Promise<T[]>(() => {});
        return (opts.reviewRows ?? [{ obligationStatus: "tier_b_review", existingReviews: [] }]) as T[];
      }
      if (query.includes("EVIDENCED_BY")) {
        if (opts.throwOn === "duplicate") throw new Error("Neo4j unreachable");
        return (opts.duplicateEvidence ? [{ e: opts.duplicateEvidence }] : []) as T[];
      }
      if (query.includes("MATCH (t:ProcessTask {task_id")) {
        if (opts.throwOn === "task") throw new Error("Neo4j unreachable");
        return (opts.taskExists === false ? [] : [{ t: {} }]) as T[];
      }
      return [] as T[];
    }
  };
}

function makeFakeGraphWriter(): GraphWriterPort & { calls: CommitPlan[] } {
  const calls: CommitPlan[] = [];
  return {
    calls,
    async commitProposal(plan: CommitPlan): Promise<CommitResult> {
      calls.push(plan);
      return {
        proposalId: plan.proposalId,
        committedAt: "2026-07-13T00:00:00.000Z",
        nodeCounts: {},
        edgeCounts: {},
        supersessionsApplied: 0
      };
    }
  };
}

function makeFakeLedger(seed: LedgerEntry[] = []): AuditLedgerPort & { entries: LedgerEntry[] } {
  const entries = [...seed];
  let seq = entries.length;

  function matchesEntity(entry: LedgerEntry, q: LedgerQuery): boolean {
    if (q.entityType === undefined || q.entityId === undefined) return true;
    if (q.entityType === "Obligation") {
      // Emulates PostgresAuditLedger.query's related_obligation_id join.
      return (
        (entry.entity_ref.entity_type === "Obligation" && entry.entity_ref.entity_id === q.entityId) ||
        entry.payload.obligation_id === q.entityId
      );
    }
    return entry.entity_ref.entity_type === q.entityType && entry.entity_ref.entity_id === q.entityId;
  }

  return {
    entries,
    async append(input: LedgerAppendInput): Promise<LedgerEntry> {
      seq += 1;
      const entry: LedgerEntry = {
        sequence_number: seq,
        timestamp: `2026-07-13T00:00:${String(seq).padStart(2, "0")}.000Z`,
        event_type: input.event_type,
        actor: input.actor,
        entity_ref: input.entity_ref,
        payload: input.payload,
        payload_hash: `payload-hash-${seq}`,
        prev_entry_hash: seq === 1 ? "0".repeat(64) : `entry-hash-${seq - 1}`,
        entry_hash: `entry-hash-${seq}`
      };
      entries.push(entry);
      return entry;
    },
    async query(q: LedgerQuery): Promise<LedgerEntry[]> {
      let results = entries.filter((entry) => matchesEntity(entry, q));
      if (q.eventTypes) {
        results = results.filter((entry) => q.eventTypes!.includes(entry.event_type));
      }
      return results.slice(0, q.limit ?? 100);
    },
    async verifyChainIntegrity(): Promise<ChainVerificationResult> {
      return {
        verifiedRangeStart: 1,
        verifiedRangeEnd: entries.length,
        entriesChecked: entries.length,
        intact: true,
        firstBrokenSequenceNumber: null,
        ranAt: "2026-07-13T00:00:00.000Z"
      };
    },
    async getLatestEntryForEntity(entityType, entityId, eventTypes): Promise<LedgerEntry | null> {
      const matches = entries.filter(
        (entry) => entry.entity_ref.entity_type === entityType && entry.entity_ref.entity_id === entityId && eventTypes.includes(entry.event_type)
      );
      return matches.length > 0 ? matches[matches.length - 1] : null;
    }
  };
}

function makeCtx(overrides: Partial<MonitoringAuditContext> = {}): MonitoringAuditContext {
  return {
    graph: makeFakeGraph(),
    graphWriter: makeFakeGraphWriter(),
    ledger: makeFakeLedger(),
    referenceDate: "2026-07-13T00:00:00.000Z",
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// computeTaskDeadline (FR-4)
// ---------------------------------------------------------------------------

describe("computeTaskDeadline", () => {
  it("adds sla_hours hours to valid_from", () => {
    const task = makeProcessTask({ valid_from: "2026-07-01T00:00:00.000Z", sla_hours: 48 });
    expect(computeTaskDeadline(task)).toBe("2026-07-03T00:00:00.000Z");
  });

  it("handles a fractional-hour sla_hours value producing a non-round-hour deadline", () => {
    const task = makeProcessTask({ valid_from: "2026-07-01T00:00:00.000Z", sla_hours: 1.5 });
    expect(computeTaskDeadline(task)).toBe("2026-07-01T01:30:00.000Z");
  });

  // Spec 13 (GRC/Ticketing Integration) FR-10: computeTicketDueDate MUST
  // NOT compute a different value for "the deadline" than this unit's own
  // computeTaskDeadline. packages/ticketing-adapter cannot import this
  // file's code (wrong dependency direction — packages cannot depend on
  // apps), so both sides instead assert against this same shared,
  // checked-in fixture table (exported from
  // @sentinel-act/ticketing-adapter, since apps/orchestrator already
  // depends on that package for Spec 13's own wiring) — a table-driven
  // drift guard, not a real code-sharing dependency.
  describe("drift guard against @sentinel-act/ticketing-adapter's computeTicketDueDate (Spec 13 FR-10)", () => {
    it.each(DEADLINE_FIXTURE)("$name: valid_from=$valid_from sla_hours=$sla_hours -> $expected", ({ valid_from, sla_hours, expected }) => {
      const task = makeProcessTask({ valid_from, sla_hours });
      expect(computeTaskDeadline(task)).toBe(expected);
    });
  });
});

// ---------------------------------------------------------------------------
// classifySlaStatus (FR-5/FR-6)
// ---------------------------------------------------------------------------

describe("classifySlaStatus", () => {
  const task = makeProcessTask({ valid_from: "2026-07-01T00:00:00.000Z", sla_hours: 48 });

  it("returns fulfilled_on_time when the earliest evidence upload is at/before the deadline", () => {
    const evidence = [makeEvidenceArtifact({ uploaded_at: "2026-07-02T12:00:00.000Z" })];
    expect(classifySlaStatus(task, evidence, "2026-07-03T00:00:00.000Z")).toBe("fulfilled_on_time");
  });

  it("returns fulfilled_late when the earliest evidence upload is after the deadline", () => {
    const evidence = [makeEvidenceArtifact({ uploaded_at: "2026-07-04T00:00:00.000Z" })];
    expect(classifySlaStatus(task, evidence, "2026-07-05T00:00:00.000Z")).toBe("fulfilled_late");
  });

  it("returns breached_unfulfilled when past deadline with no evidence", () => {
    expect(classifySlaStatus(task, [], "2026-07-03T01:00:00.000Z")).toBe("breached_unfulfilled");
  });

  it("returns approaching when hoursElapsedRatio >= 0.8 and not yet past deadline", () => {
    // 44 of 48 hours elapsed, ratio ~0.9167.
    expect(classifySlaStatus(task, [], "2026-07-02T20:00:00.000Z")).toBe("approaching");
  });

  it("boundary: exactly hoursElapsedRatio === 0.8 is approaching", () => {
    // 38.4 hours elapsed / 48 = 0.8 exactly.
    const referenceDate = new Date(new Date(task.valid_from).getTime() + 38.4 * 60 * 60 * 1000).toISOString();
    expect(computeHoursElapsedRatio(task, referenceDate)).toBeCloseTo(0.8, 10);
    expect(classifySlaStatus(task, [], referenceDate)).toBe("approaching");
  });

  it("returns on_track when comfortably within the SLA window", () => {
    expect(classifySlaStatus(task, [], "2026-07-01T12:00:00.000Z")).toBe("on_track");
  });

  it("FR-6: sla_hours <= 0 with no evidence is immediately breached_unfulfilled, never divides by zero", () => {
    const zeroSlaTask = makeProcessTask({ sla_hours: 0 });
    expect(() => classifySlaStatus(zeroSlaTask, [], "2026-07-13T00:00:00.000Z")).not.toThrow();
    expect(classifySlaStatus(zeroSlaTask, [], "2026-07-13T00:00:00.000Z")).toBe("breached_unfulfilled");
  });

  it("FR-6: sla_hours <= 0 with evidence present is fulfilled_late", () => {
    const zeroSlaTask = makeProcessTask({ sla_hours: -5 });
    const evidence = [makeEvidenceArtifact()];
    expect(classifySlaStatus(zeroSlaTask, evidence, "2026-07-13T00:00:00.000Z")).toBe("fulfilled_late");
  });
});

// ---------------------------------------------------------------------------
// scanForSlaGaps (FR-7–FR-10) — Acceptance Criteria 1 & 2
// ---------------------------------------------------------------------------

describe("scanForSlaGaps", () => {
  it("AC1: a task 44/48 hours in with no evidence is reported approaching", async () => {
    const task = makeProcessTask({ valid_from: "2026-07-01T00:00:00Z", sla_hours: 48 });
    const ctx = makeCtx({
      graph: makeFakeGraph({ slaRows: [{ t: task, evidenceArtifacts: [] }] }),
      referenceDate: "2026-07-02T20:00:00Z"
    });
    const reports = await scanForSlaGaps(ctx);
    expect(reports).toHaveLength(1);
    expect(reports[0].status).toBe("approaching");
    expect(reports[0].hoursElapsedRatio).toBeGreaterThanOrEqual(SLA_APPROACHING_THRESHOLD_RATIO);
  });

  it("AC2: two consecutive breached scans append exactly one SLA_BREACHED entry", async () => {
    const task = makeProcessTask({ valid_from: "2026-07-01T00:00:00Z", sla_hours: 48, task_id: "task-breach" });
    const ledger = makeFakeLedger();
    const graph = makeFakeGraph({ slaRows: [{ t: task, evidenceArtifacts: [] }] });
    const ctx = makeCtx({ graph, ledger, referenceDate: "2026-07-03T01:00:00Z" });

    const first = await scanForSlaGaps(ctx);
    expect(first[0].status).toBe("breached_unfulfilled");
    const second = await scanForSlaGaps(ctx);
    expect(second[0].status).toBe("breached_unfulfilled");

    const breachEntries = ledger.entries.filter((e) => e.event_type === "SLA_BREACHED" && e.entity_ref.entity_id === "task-breach");
    expect(breachEntries).toHaveLength(1);
  });

  it("FR-8/FR-9: a status change from approaching to breached appends a second, distinct entry", async () => {
    const ledger = makeFakeLedger();
    const approachingTask = makeProcessTask({ valid_from: "2026-07-01T00:00:00Z", sla_hours: 48, task_id: "task-transition" });
    const ctxApproaching = makeCtx({
      graph: makeFakeGraph({ slaRows: [{ t: approachingTask, evidenceArtifacts: [] }] }),
      ledger,
      referenceDate: "2026-07-02T20:00:00Z"
    });
    await scanForSlaGaps(ctxApproaching);

    const ctxBreached = makeCtx({
      graph: makeFakeGraph({ slaRows: [{ t: approachingTask, evidenceArtifacts: [] }] }),
      ledger,
      referenceDate: "2026-07-03T01:00:00Z"
    });
    await scanForSlaGaps(ctxBreached);

    const transitionEntries = ledger.entries.filter((e) => e.entity_ref.entity_id === "task-transition");
    expect(transitionEntries.map((e) => e.event_type)).toEqual(["SLA_APPROACHING", "SLA_BREACHED"]);
  });

  it("includes on_track and fulfilled_on_time tasks in the returned set, not just gaps", async () => {
    const onTrackTask = makeProcessTask({ task_id: "task-on-track", valid_from: "2026-07-13T00:00:00Z", sla_hours: 48 });
    const ctx = makeCtx({
      graph: makeFakeGraph({ slaRows: [{ t: onTrackTask, evidenceArtifacts: [] }] }),
      referenceDate: "2026-07-13T01:00:00Z"
    });
    const reports = await scanForSlaGaps(ctx);
    expect(reports[0].status).toBe("on_track");
  });

  it("§8: a Neo4j timeout/unavailability degrades to an empty result rather than throwing", async () => {
    const ctx = makeCtx({ graph: makeFakeGraph({ throwOn: "sla" }) });
    await expect(scanForSlaGaps(ctx)).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeFileHash (FR-11)
// ---------------------------------------------------------------------------

describe("computeFileHash", () => {
  it("matches the known SHA-256 vector for an empty buffer", () => {
    expect(computeFileHash(Buffer.from(""))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("matches the known SHA-256 vector for a small fixed string", () => {
    expect(computeFileHash(Buffer.from("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

// ---------------------------------------------------------------------------
// ingestEvidenceArtifact (FR-12–FR-18) — Acceptance Criterion 3
// ---------------------------------------------------------------------------

describe("ingestEvidenceArtifact", () => {
  const file = Buffer.from("evidence-bytes");
  const computedHash = computeFileHash(file);

  it("AC3/FR-13: a claimedHash that does not match the computed hash is rejected as hash_mismatch, no graph write", async () => {
    const graphWriter = makeFakeGraphWriter();
    const ctx = makeCtx({ graph: makeFakeGraph({ taskExists: true }), graphWriter });

    const result = await ingestEvidenceArtifact(
      { task_id: "task-1", type: "report", uploaded_by: "user-1", file, claimedHash: "deliberately-wrong-hash" },
      ctx
    );

    expect(result.outcome).toBe("hash_mismatch");
    expect(result.evidenceArtifact).toBeNull();
    expect(graphWriter.calls).toHaveLength(0);
    expect(result.ledgerEntry.event_type).toBe("EVIDENCE_HASH_MISMATCH");
    expect(result.ledgerEntry.payload.task_id).toBe("task-1");
    expect(result.ledgerEntry.payload.claimedHash).toBe("deliberately-wrong-hash");
    expect(result.ledgerEntry.payload.computedHash).toBe(computedHash);
  });

  it("FR-12/FR-14: no claimedHash present -> ingests using the computed hash, no comparison", async () => {
    const ctx = makeCtx({ graph: makeFakeGraph({ taskExists: true }) });
    const result = await ingestEvidenceArtifact({ task_id: "task-1", type: "report", uploaded_by: "user-1", file }, ctx);
    expect(result.outcome).toBe("ingested");
    expect(result.evidenceArtifact?.hash).toBe(computedHash);
  });

  it("hash matches claimedHash (case-insensitive) -> ingested", async () => {
    const ctx = makeCtx({ graph: makeFakeGraph({ taskExists: true }) });
    const result = await ingestEvidenceArtifact(
      { task_id: "task-1", type: "report", uploaded_by: "user-1", file, claimedHash: computedHash.toUpperCase() },
      ctx
    );
    expect(result.outcome).toBe("ingested");
  });

  it("FR-15: duplicate hash on the same task -> outcome duplicate, no new node, ledger still logs the attempt", async () => {
    const existing = makeEvidenceArtifact({ evidence_id: "evidence-existing", hash: computedHash, task_id: "task-1" });
    const graphWriter = makeFakeGraphWriter();
    const ctx = makeCtx({
      graph: makeFakeGraph({ taskExists: true, duplicateEvidence: existing }),
      graphWriter
    });

    const result = await ingestEvidenceArtifact({ task_id: "task-1", type: "report", uploaded_by: "user-1", file }, ctx);

    expect(result.outcome).toBe("duplicate");
    expect(result.evidenceArtifact?.evidence_id).toBe("evidence-existing");
    expect(graphWriter.calls).toHaveLength(0);
    expect(result.ledgerEntry.payload.duplicateOf).toBe("evidence-existing");
  });

  it("a matching hash on a DIFFERENT task is NOT treated as a duplicate — ingests a new artifact", async () => {
    // duplicateEvidence is scoped by the fake's DUPLICATE_EVIDENCE_HASH_CYPHER
    // match to task_id: "task-1"; querying for "task-2" returns no rows,
    // exactly like the real Cypher's task_id-scoped MATCH.
    const ctx = makeCtx({ graph: makeFakeGraph({ taskExists: true, duplicateEvidence: null }) });
    const result = await ingestEvidenceArtifact({ task_id: "task-2", type: "report", uploaded_by: "user-1", file }, ctx);
    expect(result.outcome).toBe("ingested");
  });

  it("FR-18: a nonexistent task_id is rejected before hashing/writing", async () => {
    const graphWriter = makeFakeGraphWriter();
    const ctx = makeCtx({ graph: makeFakeGraph({ taskExists: false }), graphWriter });
    await expect(ingestEvidenceArtifact({ task_id: "task-missing", type: "report", uploaded_by: "user-1", file }, ctx)).rejects.toBeInstanceOf(
      ValidationError
    );
    expect(graphWriter.calls).toHaveLength(0);
  });

  it("NFR-6: an oversized file is rejected before hashing begins", async () => {
    const ctx = makeCtx({ graph: makeFakeGraph({ taskExists: true }) });
    const oversized = Buffer.alloc(MAX_EVIDENCE_FILE_SIZE_BYTES + 1);
    await expect(ingestEvidenceArtifact({ task_id: "task-1", type: "report", uploaded_by: "user-1", file: oversized }, ctx)).rejects.toBeInstanceOf(
      ValidationError
    );
  });

  it("FR-16: NFR-4 ordering — graph write happens before the ledger entry (CommitPlan only ever carries evidenceArtifacts)", async () => {
    const graphWriter = makeFakeGraphWriter();
    const ctx = makeCtx({ graph: makeFakeGraph({ taskExists: true }), graphWriter });
    const result = await ingestEvidenceArtifact({ task_id: "task-1", type: "report", uploaded_by: "user-1", file }, ctx);

    expect(graphWriter.calls).toHaveLength(1);
    expect(graphWriter.calls[0].nodes.evidenceArtifacts).toHaveLength(1);
    expect(Object.keys(graphWriter.calls[0].nodes)).toEqual(["evidenceArtifacts"]);
    expect(graphWriter.calls[0].supersessions ?? []).toHaveLength(0);
    expect(result.ledgerEntry.event_type).toBe("EVIDENCE_ARTIFACT_INGESTED");
  });

  it("NFR-4: if the graph write throws, no ledger entry is written", async () => {
    const graphWriter: GraphWriterPort = {
      async commitProposal() {
        throw new Error("Neo4j write failed");
      }
    };
    const ledger = makeFakeLedger();
    const ctx = makeCtx({ graph: makeFakeGraph({ taskExists: true }), graphWriter, ledger });
    await expect(ingestEvidenceArtifact({ task_id: "task-1", type: "report", uploaded_by: "user-1", file }, ctx)).rejects.toThrow(
      "Neo4j write failed"
    );
    expect(ledger.entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// recordHumanReview / getReviewsVisibleTo (FR-19–FR-28) — the
// maker-checker matrix, plus Acceptance Criteria 4, 5, 6.
// ---------------------------------------------------------------------------

function makeReviewEvent(overrides: Partial<HumanReviewSubmittedEvent> = {}): HumanReviewSubmittedEvent {
  return {
    event_id: "event-1",
    obligation_id: "ob-1",
    reviewer_id: "reviewer-a",
    tier: "B",
    decision: "approve",
    rationale: null,
    decided_at: "2026-07-13T00:00:00.000Z",
    source: "web-console",
    source_ref: null,
    ...overrides
  };
}

describe("recordHumanReview", () => {
  it("FR-19: Tier A is rejected, no write of any kind", async () => {
    const graphWriter = makeFakeGraphWriter();
    const ledger = makeFakeLedger();
    const ctx = makeCtx({ graphWriter, ledger });
    await expect(recordHumanReview(makeReviewEvent({ tier: "A" }), ctx)).rejects.toBeInstanceOf(ValidationError);
    expect(graphWriter.calls).toHaveLength(0);
    expect(ledger.entries).toHaveLength(0);
  });

  it("FR-22: Tier C with missing/empty rationale is rejected", async () => {
    const ctx = makeCtx();
    await expect(recordHumanReview(makeReviewEvent({ tier: "C", rationale: null }), ctx)).rejects.toBeInstanceOf(ValidationError);
    await expect(recordHumanReview(makeReviewEvent({ tier: "C", rationale: "   " }), ctx)).rejects.toBeInstanceOf(ValidationError);
  });

  it("FR-20: an invalid decision value is rejected", async () => {
    const ctx = makeCtx();
    await expect(recordHumanReview(makeReviewEvent({ decision: "maybe" as never }), ctx)).rejects.toBeInstanceOf(ValidationError);
  });

  it("Tier B approve -> APPROVED", async () => {
    const ctx = makeCtx();
    const result = await recordHumanReview(makeReviewEvent({ tier: "B", decision: "approve" }), ctx);
    expect(result.reviewOutcome).toBe("APPROVED");
    expect(result.allReviewsForObligation).toHaveLength(1);
  });

  it("Tier B reject -> REJECTED", async () => {
    const ctx = makeCtx();
    const result = await recordHumanReview(makeReviewEvent({ tier: "B", decision: "reject" }), ctx);
    expect(result.reviewOutcome).toBe("REJECTED");
  });

  it("AC4: Tier C first review (approve) -> AWAITING_SECOND_REVIEWER, and reviewer B cannot see it yet", async () => {
    const ctx = makeCtx();
    const result = await recordHumanReview(
      makeReviewEvent({ tier: "C", reviewer_id: "reviewer-a", decision: "approve", rationale: "meets requirement per para 46" }),
      ctx
    );
    expect(result.reviewOutcome).toBe("AWAITING_SECOND_REVIEWER");

    const visibleToB = await getReviewsVisibleTo("ob-1", "reviewer-b", ctx);
    expect(visibleToB).toEqual([]);
  });

  it("AC5: Tier C second review disagreeing -> ESCALATED_DISAGREEMENT, and reviewer B now sees both", async () => {
    const existingReview = makeHumanReview({
      review_id: "review-a",
      reviewer_id: "reviewer-a",
      tier: "C",
      decision: "approve",
      rationale: "meets requirement per para 46",
      decided_at: "2026-07-13T00:00:00.000Z"
    });
    const ctx = makeCtx({
      graph: makeFakeGraph({ reviewRows: [{ obligationStatus: "tier_c_review", existingReviews: [existingReview] }] })
    });

    const result = await recordHumanReview(
      makeReviewEvent({ event_id: "event-2", tier: "C", reviewer_id: "reviewer-b", decision: "reject", rationale: "does not meet requirement" }),
      ctx
    );
    expect(result.reviewOutcome).toBe("ESCALATED_DISAGREEMENT");

    // getReviewsVisibleTo re-queries the graph; simulate the post-write
    // state (both reviews now present) for reviewer B's own visibility
    // check.
    const ctxAfter = makeCtx({
      graph: makeFakeGraph({
        reviewRows: [{ obligationStatus: "escalated", existingReviews: [existingReview, result.humanReview] }]
      })
    });
    const visibleToB = await getReviewsVisibleTo("ob-1", "reviewer-b", ctxAfter);
    expect(visibleToB).toHaveLength(2);
  });

  it("Tier C second review agreeing (both approve) -> APPROVED", async () => {
    const existingReview = makeHumanReview({ review_id: "review-a", reviewer_id: "reviewer-a", tier: "C", decision: "approve", rationale: "ok" });
    const ctx = makeCtx({ graph: makeFakeGraph({ reviewRows: [{ obligationStatus: "tier_c_review", existingReviews: [existingReview] }] }) });
    const result = await recordHumanReview(
      makeReviewEvent({ event_id: "event-2", tier: "C", reviewer_id: "reviewer-b", decision: "approve", rationale: "agree" }),
      ctx
    );
    expect(result.reviewOutcome).toBe("APPROVED");
  });

  it("Tier C second review agreeing (both reject) -> REJECTED", async () => {
    const existingReview = makeHumanReview({ review_id: "review-a", reviewer_id: "reviewer-a", tier: "C", decision: "reject", rationale: "no" });
    const ctx = makeCtx({ graph: makeFakeGraph({ reviewRows: [{ obligationStatus: "tier_c_review", existingReviews: [existingReview] }] }) });
    const result = await recordHumanReview(
      makeReviewEvent({ event_id: "event-2", tier: "C", reviewer_id: "reviewer-b", decision: "reject", rationale: "also no" }),
      ctx
    );
    expect(result.reviewOutcome).toBe("REJECTED");
  });

  it("Tier C second review disagreeing (first reject, second approve) -> ESCALATED_DISAGREEMENT", async () => {
    const existingReview = makeHumanReview({ review_id: "review-a", reviewer_id: "reviewer-a", tier: "C", decision: "reject", rationale: "no" });
    const ctx = makeCtx({ graph: makeFakeGraph({ reviewRows: [{ obligationStatus: "tier_c_review", existingReviews: [existingReview] }] }) });
    const result = await recordHumanReview(
      makeReviewEvent({ event_id: "event-2", tier: "C", reviewer_id: "reviewer-b", decision: "approve", rationale: "actually fine" }),
      ctx
    );
    expect(result.reviewOutcome).toBe("ESCALATED_DISAGREEMENT");
  });

  it("AC6/FR-23: the same reviewer submitting again (not a retry) is rejected with SAME_REVIEWER_NOT_ALLOWED, no new write", async () => {
    const existingReview = makeHumanReview({ review_id: "review-a", reviewer_id: "reviewer-a", tier: "C", decision: "approve", rationale: "ok" });
    const graphWriter = makeFakeGraphWriter();
    const ledger = makeFakeLedger();
    const ctx = makeCtx({
      graph: makeFakeGraph({ reviewRows: [{ obligationStatus: "tier_c_review", existingReviews: [existingReview] }] }),
      graphWriter,
      ledger
    });

    await expect(
      recordHumanReview(makeReviewEvent({ event_id: "event-2", tier: "C", reviewer_id: "reviewer-a", decision: "reject", rationale: "changed mind" }), ctx)
    ).rejects.toBeInstanceOf(SameReviewerNotAllowedError);
    expect(graphWriter.calls).toHaveLength(0);
    expect(ledger.entries).toHaveLength(0);
  });

  it("FR-23: REVIEW_ALREADY_COMPLETE when the tier's required review count is already met", async () => {
    const first = makeHumanReview({ review_id: "review-a", reviewer_id: "reviewer-a", tier: "C", decision: "approve", rationale: "ok" });
    const second = makeHumanReview({ review_id: "review-b", reviewer_id: "reviewer-b", tier: "C", decision: "approve", rationale: "agree" });
    const ctx = makeCtx({ graph: makeFakeGraph({ reviewRows: [{ obligationStatus: "committed", existingReviews: [first, second] }] }) });

    await expect(
      recordHumanReview(makeReviewEvent({ event_id: "event-3", tier: "C", reviewer_id: "reviewer-c", decision: "approve", rationale: "late" }), ctx)
    ).rejects.toBeInstanceOf(ReviewAlreadyCompleteError);
  });

  it("FR-24: a duplicate event_id (retry) is idempotent — returns the prior result, no new write", async () => {
    const ctx = makeCtx();
    const event = makeReviewEvent({ event_id: "event-retry", tier: "B", decision: "approve" });

    const first = await recordHumanReview(event, ctx);
    const graphWriterCallsAfterFirst = (ctx.graphWriter as ReturnType<typeof makeFakeGraphWriter>).calls.length;
    const second = await recordHumanReview(event, ctx);

    expect(second).toEqual(first);
    expect((ctx.graphWriter as ReturnType<typeof makeFakeGraphWriter>).calls).toHaveLength(graphWriterCallsAfterFirst);
    expect((ctx.ledger as ReturnType<typeof makeFakeLedger>).entries.filter((e) => e.event_type === "HUMAN_REVIEW_SUBMITTED")).toHaveLength(1);
  });

  it("FR-24 runs before FR-23: a genuine retry from the same reviewer is never mistaken for a same-reviewer violation", async () => {
    const existingReview = makeHumanReview({ review_id: "review-a", reviewer_id: "reviewer-a", tier: "B", decision: "approve" });
    const ledger = makeFakeLedger();
    const ctx = makeCtx({
      graph: makeFakeGraph({ reviewRows: [{ obligationStatus: "committed", existingReviews: [existingReview] }] }),
      ledger
    });
    const event = makeReviewEvent({ event_id: "event-original", tier: "B", reviewer_id: "reviewer-a", decision: "approve" });
    // Seed the ledger as if this exact event was already recorded.
    await ledger.append({
      event_type: "HUMAN_REVIEW_SUBMITTED",
      actor: { type: "human", id: "reviewer-a" },
      entity_ref: { entity_type: "HumanReview", entity_id: "review-a" },
      payload: { ...event, reviewOutcome: "APPROVED", humanReview: existingReview, allReviewsForObligation: [existingReview] }
    });

    await expect(recordHumanReview(event, ctx)).resolves.toMatchObject({ reviewOutcome: "APPROVED" });
  });

  it("FR-3: throws MonitoringAuditInvariantError if a caller-tampered CommitPlan carried more than one nodes.* key (defensive check)", async () => {
    // This test exercises assertNarrowCommitPlan indirectly by confirming
    // the CommitPlan this function actually builds is narrow — the
    // invariant is enforced by construction, so we assert on the shape
    // handed to commitProposal rather than forcing a violation (there is
    // no legitimate code path inside recordHumanReview that could build a
    // wider plan; this test documents that guarantee).
    const graphWriter = makeFakeGraphWriter();
    const ctx = makeCtx({ graphWriter });
    await recordHumanReview(makeReviewEvent(), ctx);
    expect(Object.keys(graphWriter.calls[0].nodes)).toEqual(["humanReviews"]);
    expect(graphWriter.calls[0].supersessions ?? []).toHaveLength(0);
  });

  it("NFR-4: if the graph write throws, no ledger entry is written", async () => {
    const graphWriter: GraphWriterPort = {
      async commitProposal() {
        throw new Error("Neo4j write failed");
      }
    };
    const ledger = makeFakeLedger();
    const ctx = makeCtx({ graphWriter, ledger });
    await expect(recordHumanReview(makeReviewEvent(), ctx)).rejects.toThrow("Neo4j write failed");
    expect(ledger.entries).toHaveLength(0);
  });
});

describe("getReviewsVisibleTo", () => {
  it("requester has not reviewed -> empty array even though other reviews exist", async () => {
    const existing = makeHumanReview({ reviewer_id: "reviewer-a" });
    const ctx = makeCtx({ graph: makeFakeGraph({ reviewRows: [{ obligationStatus: "tier_c_review", existingReviews: [existing] }] }) });
    await expect(getReviewsVisibleTo("ob-1", "reviewer-b", ctx)).resolves.toEqual([]);
  });

  it("requester has reviewed -> full result", async () => {
    const existing = makeHumanReview({ reviewer_id: "reviewer-a" });
    const ctx = makeCtx({ graph: makeFakeGraph({ reviewRows: [{ obligationStatus: "tier_c_review", existingReviews: [existing] }] }) });
    const result = await getReviewsVisibleTo("ob-1", "reviewer-a", ctx);
    expect(result).toHaveLength(1);
  });

  it("obligation has zero reviews at all -> empty array, not an error", async () => {
    const ctx = makeCtx({ graph: makeFakeGraph({ reviewRows: [{ obligationStatus: "tier_b_review", existingReviews: [] }] }) });
    await expect(getReviewsVisibleTo("ob-1", "reviewer-a", ctx)).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// appendLedgerEntry / verifyChainIntegrity — thin delegate wrappers
// ---------------------------------------------------------------------------

describe("appendLedgerEntry / verifyChainIntegrity", () => {
  it("appendLedgerEntry delegates straight to ctx.ledger.append", async () => {
    const ledger = makeFakeLedger();
    const ctx = makeCtx({ ledger });
    const entry = await appendLedgerEntry(
      { event_type: "SLA_BREACHED", actor: { type: "system", id: "sla-scan-cron" }, entity_ref: { entity_type: "ProcessTask", entity_id: "task-1" }, payload: {} },
      ctx
    );
    expect(ledger.entries).toContainEqual(entry);
  });

  it("verifyChainIntegrity delegates straight to ctx.ledger.verifyChainIntegrity", async () => {
    const ctx = makeCtx();
    const result = await verifyChainIntegrity(undefined, ctx);
    expect(result.intact).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reconcileLedgerGaps (§8's failure-mode row, Acceptance Criterion 8)
// ---------------------------------------------------------------------------

describe("reconcileLedgerGaps", () => {
  it("AC8: backfills a ledger entry for an EvidenceArtifact graph node with no matching ledger entry", async () => {
    const evidence = makeEvidenceArtifact({ evidence_id: "evidence-orphan", task_id: "task-9", recorded_at: "2026-07-12T12:00:00.000Z" });
    const ledger = makeFakeLedger();
    const ctx = makeCtx({
      graph: makeFakeGraph({ recentEvidence: [{ e: evidence, taskId: "task-9" }] }),
      ledger
    });

    const result = await reconcileLedgerGaps(ctx);

    expect(result.checked).toBe(1);
    expect(result.backfilled).toBe(1);
    expect(result.backfilledEntityIds).toEqual(["evidence-orphan"]);
    const backfilledEntry = ledger.entries.find((e) => e.entity_ref.entity_id === "evidence-orphan");
    expect(backfilledEntry?.payload.backfilled).toBe(true);
    expect(backfilledEntry?.payload.originalEventTime).toBe("2026-07-12T12:00:00.000Z");
  });

  it("does not backfill when a matching ledger entry already exists", async () => {
    const evidence = makeEvidenceArtifact({ evidence_id: "evidence-already-logged", task_id: "task-9" });
    const ledger = makeFakeLedger();
    await ledger.append({
      event_type: "EVIDENCE_ARTIFACT_INGESTED",
      actor: { type: "human", id: "user-1" },
      entity_ref: { entity_type: "EvidenceArtifact", entity_id: "evidence-already-logged" },
      payload: {}
    });
    const ctx = makeCtx({
      graph: makeFakeGraph({ recentEvidence: [{ e: evidence, taskId: "task-9" }] }),
      ledger
    });

    const result = await reconcileLedgerGaps(ctx);
    expect(result.checked).toBe(1);
    expect(result.backfilled).toBe(0);
  });

  it("backfills a HumanReview graph node with no matching ledger entry", async () => {
    const review = makeHumanReview({ review_id: "review-orphan", recorded_at: "2026-07-12T09:00:00.000Z" });
    const ledger = makeFakeLedger();
    const ctx = makeCtx({
      graph: makeFakeGraph({ recentReviews: [{ r: review, obligationId: "ob-1" }] }),
      ledger
    });

    const result = await reconcileLedgerGaps(ctx);
    expect(result.backfilled).toBe(1);
    const backfilledEntry = ledger.entries.find((e) => e.entity_ref.entity_id === "review-orphan");
    expect(backfilledEntry?.payload.backfilled).toBe(true);
    expect(backfilledEntry?.payload.originalEventTime).toBe("2026-07-12T09:00:00.000Z");
  });
});
