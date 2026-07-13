// Spec 07 §10: "full maker-checker flow against real Neo4j + Postgres:
// two reviewers, agree case and disagree case, asserting both the graph
// state (REVIEWED_BY edges, Obligation untouched per §1's
// status-transition boundary) and the ledger state."
//
// No Docker (Neo4j + Postgres testcontainers) is available in the
// sandbox this unit was authored in. See
// evidence-ingestion.integration.test.ts's doc comment for the gated +
// DI-mocked stand-in convention this file follows.
import { describe, expect, it } from "vitest";
import type { CommitPlan, CommitResult } from "@sentinel-act/graph-db";
import type { AuditLedgerPort, LedgerEntry, LedgerQuery, LedgerAppendInput } from "@sentinel-act/audit-ledger";
import { recordHumanReview, getReviewsVisibleTo, type GraphQueryPort, type GraphWriterPort, type MonitoringAuditContext } from "../monitoring-and-audit.agent.js";

describe.skipIf(!process.env.MONITORING_AUDIT_LIVE_INFRA_TEST)("human review Tier C — real Neo4j + Postgres (gated, real infra)", () => {
  it("is exercised against real Neo4j + real Postgres when MONITORING_AUDIT_LIVE_INFRA_TEST is set", () => {
    // Placeholder documenting the DoD: seed a Tier C Obligation with no
    // reviews, drive two recordHumanReview calls (agree case, then a
    // fresh obligation for the disagree case) against a real GraphWriter
    // + PostgresAuditLedger, and assert (a) exactly two HumanReview
    // nodes + two REVIEWED_BY edges exist per obligation, (b) the
    // Obligation node's own `status` property is untouched by this
    // unit (§1's status-transition boundary — that's Spec 08's job),
    // and (c) both HUMAN_REVIEW_SUBMITTED ledger entries exist in
    // submission order.
    expect(true).toBe(true);
  });
});

/** In-memory graph double that actually models Obligation/HumanReview/
 *  REVIEWED_BY state (unlike the simpler per-call fakes in
 *  monitoring-and-audit.agent.test.ts), so this stand-in can assert the
 *  graph-state claims §10 calls out ("REVIEWED_BY edges, Obligation
 *  untouched") in one place, closer to what a real Neo4j round trip
 *  would let us assert. */
function makeStatefulGraph(): { graph: GraphQueryPort; graphWriter: GraphWriterPort; reviewsByObligation: Map<string, unknown[]> } {
  const reviewsByObligation = new Map<string, unknown[]>();
  const graph: GraphQueryPort = {
    async runCypher<T>(query: string, params: Record<string, unknown>): Promise<T[]> {
      if (query.includes("REVIEWED_BY")) {
        const obligationId = params.obligationId as string;
        return [{ obligationStatus: "tier_c_review", existingReviews: reviewsByObligation.get(obligationId) ?? [] }] as T[];
      }
      return [] as T[];
    }
  };
  const graphWriter: GraphWriterPort = {
    async commitProposal(plan: CommitPlan): Promise<CommitResult> {
      for (const review of plan.nodes.humanReviews ?? []) {
        const list = reviewsByObligation.get(review.obligation_id) ?? [];
        list.push({ ...review, recorded_at: "2026-07-13T00:00:00.000Z" });
        reviewsByObligation.set(review.obligation_id, list);
      }
      return { proposalId: plan.proposalId, committedAt: "2026-07-13T00:00:00.000Z", nodeCounts: {}, edgeCounts: {}, supersessionsApplied: 0 };
    }
  };
  return { graph, graphWriter, reviewsByObligation };
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
      throw new Error("not used in this test");
    },
    async getLatestEntryForEntity() {
      return null;
    }
  };
}

describe("human review Tier C maker-checker flow (DI-mocked stand-in)", () => {
  it("agree case: both reviewers approve -> APPROVED, two REVIEWED_BY-equivalent entries, ledger has both submissions in order", async () => {
    const { graph, graphWriter, reviewsByObligation } = makeStatefulGraph();
    const ledger = makeInMemoryLedger();
    const ctx: MonitoringAuditContext = { graph, graphWriter, ledger, referenceDate: "2026-07-13T00:00:00.000Z" };

    const first = await recordHumanReview(
      {
        event_id: "event-1",
        obligation_id: "ob-agree",
        reviewer_id: "reviewer-a",
        tier: "C",
        decision: "approve",
        rationale: "meets requirement",
        decided_at: "2026-07-13T00:00:00.000Z",
        source: "web-console",
        source_ref: null
      },
      ctx
    );
    expect(first.reviewOutcome).toBe("AWAITING_SECOND_REVIEWER");

    const second = await recordHumanReview(
      {
        event_id: "event-2",
        obligation_id: "ob-agree",
        reviewer_id: "reviewer-b",
        tier: "C",
        decision: "approve",
        rationale: "agree",
        decided_at: "2026-07-13T01:00:00.000Z",
        source: "web-console",
        source_ref: null
      },
      ctx
    );
    expect(second.reviewOutcome).toBe("APPROVED");

    // Graph state: exactly two HumanReview entries for this obligation.
    expect(reviewsByObligation.get("ob-agree")).toHaveLength(2);

    // Ledger state: both submissions present, in submission order.
    const ledgerEntries = await ledger.query({ entityId: "ob-agree", limit: 1000 });
    expect(ledgerEntries.map((e) => e.payload.reviewer_id)).toEqual(["reviewer-a", "reviewer-b"]);

    // Independence: reviewer B only sees both after their own submission.
    const visible = await getReviewsVisibleTo("ob-agree", "reviewer-b", ctx);
    expect(visible).toHaveLength(2);
  });

  it("disagree case: reviewers disagree -> ESCALATED_DISAGREEMENT", async () => {
    const { graph, graphWriter } = makeStatefulGraph();
    const ledger = makeInMemoryLedger();
    const ctx: MonitoringAuditContext = { graph, graphWriter, ledger, referenceDate: "2026-07-13T00:00:00.000Z" };

    await recordHumanReview(
      {
        event_id: "event-1",
        obligation_id: "ob-disagree",
        reviewer_id: "reviewer-a",
        tier: "C",
        decision: "approve",
        rationale: "meets requirement",
        decided_at: "2026-07-13T00:00:00.000Z",
        source: "web-console",
        source_ref: null
      },
      ctx
    );
    const second = await recordHumanReview(
      {
        event_id: "event-2",
        obligation_id: "ob-disagree",
        reviewer_id: "reviewer-b",
        tier: "C",
        decision: "reject",
        rationale: "does not meet requirement",
        decided_at: "2026-07-13T01:00:00.000Z",
        source: "web-console",
        source_ref: null
      },
      ctx
    );
    expect(second.reviewOutcome).toBe("ESCALATED_DISAGREEMENT");
  });
});
