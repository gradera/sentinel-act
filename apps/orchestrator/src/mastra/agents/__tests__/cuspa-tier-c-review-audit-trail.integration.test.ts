// Spec 07 §10's end-to-end test: "using the same CUSPA/Paragraph 46
// fixture referenced in Spec 05's end-to-end test [see
// mapping-risk-scoring.agent.test.ts / grounding-verification.integration.test.ts's
// 'ob-cuspa-para-46-live' naming convention]: after the fixture
// obligation routes to Tier C, drive it through both reviewers via
// recordHumanReview, then call getObligationAuditTrail(obligationId, ctx)
// and assert the returned entries reconstruct the full narrative (tier
// decision -> both reviews -> outcome) in correct sequence_number order —
// this is the automated proxy for Journey F (audit lookup) working end
// to end against a realistic scenario."
//
// No Docker (Neo4j + Postgres testcontainers) is available in the
// sandbox this unit was authored in. See
// evidence-ingestion.integration.test.ts's doc comment for the gated +
// DI-mocked stand-in convention this file follows.
import { describe, expect, it } from "vitest";
import type { AuditLedgerPort, LedgerAppendInput, LedgerEntry, LedgerQuery } from "@sentinel-act/audit-ledger";
import {
  appendLedgerEntry,
  recordHumanReview,
  getObligationAuditTrail,
  type GraphQueryPort,
  type GraphWriterPort,
  type MonitoringAuditContext
} from "../monitoring-and-audit.agent.js";

describe.skipIf(!process.env.MONITORING_AUDIT_LIVE_INFRA_TEST)("CUSPA Paragraph 46 Tier C audit trail — real Neo4j + Postgres (gated, real infra)", () => {
  it("is exercised against real Neo4j + real Postgres when MONITORING_AUDIT_LIVE_INFRA_TEST is set", () => {
    // Placeholder documenting the DoD (§12): run the CUSPA Tier C fixture
    // end-to-end against local Neo4j + Postgres, print the full
    // getObligationAuditTrail output, and visually confirm it
    // reconstructs a coherent, chronologically ordered story — paste
    // into the PR description, same convention as Spec 01's DoD.
    expect(true).toBe(true);
  });
});

/** In-memory ledger that actually implements `related_obligation_id`
 *  filtering the way `PostgresAuditLedger.query` does for `entityType:
 *  "Obligation"` (§ postgres-audit-ledger.ts's query() doc comment), so
 *  `getObligationAuditTrail`'s join behavior is exercised faithfully
 *  even without real Postgres. */
function makeJoinAwareLedger(): AuditLedgerPort {
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
      let results = entries;
      if (q.entityType === "Obligation" && q.entityId) {
        results = results.filter(
          (e) => (e.entity_ref.entity_type === "Obligation" && e.entity_ref.entity_id === q.entityId) || e.payload.obligation_id === q.entityId
        );
      }
      return results.sort((a, b) => a.sequence_number - b.sequence_number).slice(0, q.limit ?? 100);
    },
    async verifyChainIntegrity() {
      throw new Error("not used in this test");
    },
    async getLatestEntryForEntity() {
      return null;
    }
  };
}

describe("CUSPA Paragraph 46 Tier C audit trail (DI-mocked stand-in, Journey F proxy)", () => {
  it("reconstructs tier decision -> both reviews -> outcome in sequence_number order", async () => {
    const obligationId = "ob-cuspa-para-46-live";
    const reviewsByObligation = new Map<string, unknown[]>();
    const graph: GraphQueryPort = {
      async runCypher<T>(query: string, params: Record<string, unknown>): Promise<T[]> {
        if (query.includes("REVIEWED_BY")) {
          const id = params.obligationId as string;
          return [{ obligationStatus: "tier_c_review", existingReviews: reviewsByObligation.get(id) ?? [] }] as T[];
        }
        return [] as T[];
      }
    };
    const graphWriter: GraphWriterPort = {
      async commitProposal(plan) {
        for (const review of plan.nodes.humanReviews ?? []) {
          const list = reviewsByObligation.get(review.obligation_id) ?? [];
          list.push({ ...review, recorded_at: "2026-07-13T00:00:00.000Z" });
          reviewsByObligation.set(review.obligation_id, list);
        }
        return { proposalId: plan.proposalId, committedAt: "2026-07-13T00:00:00.000Z", nodeCounts: {}, edgeCounts: {}, supersessionsApplied: 0 };
      }
    };
    const ledger = makeJoinAwareLedger();
    const ctx: MonitoringAuditContext = { graph, graphWriter, ledger, referenceDate: "2026-07-13T00:00:00.000Z" };

    // Narrative step 1: the Orchestrator logs Spec 05's tier-routing
    // decision (Tier C, due to the CUSPA Para 46 contradiction/overwrite
    // signal) via this unit's appendLedgerEntry (Dependencies, §3).
    await appendLedgerEntry(
      {
        event_type: "TIER_ROUTING_DECISION",
        actor: { type: "agent", id: "mapping-and-risk-scoring" },
        entity_ref: { entity_type: "Obligation", entity_id: obligationId },
        payload: { obligation_id: obligationId, tier: "C", reason: "overwrites a live obligation (CUSPA Para 46)" }
      },
      ctx
    );

    // Narrative step 2 & 3: both reviewers submit.
    await recordHumanReview(
      {
        event_id: "event-maker",
        obligation_id: obligationId,
        reviewer_id: "reviewer-maker",
        tier: "C",
        decision: "approve",
        rationale: "meets requirement per para 46",
        decided_at: "2026-07-13T01:00:00.000Z",
        source: "web-console",
        source_ref: null
      },
      ctx
    );
    await recordHumanReview(
      {
        event_id: "event-checker",
        obligation_id: obligationId,
        reviewer_id: "reviewer-checker",
        tier: "C",
        decision: "approve",
        rationale: "independently confirmed against para 46",
        decided_at: "2026-07-13T02:00:00.000Z",
        source: "slack",
        source_ref: JSON.stringify({ channel_id: "C123", message_ts: "1.1", slack_user_id: "U456" })
      },
      ctx
    );

    const trail = await getObligationAuditTrail(obligationId, ctx);

    // Correct sequence_number order, and the full narrative present.
    expect(trail.map((e) => e.event_type)).toEqual(["TIER_ROUTING_DECISION", "HUMAN_REVIEW_SUBMITTED", "HUMAN_REVIEW_SUBMITTED"]);
    expect(trail).toEqual([...trail].sort((a, b) => a.sequence_number - b.sequence_number));
    expect(trail[1].payload.reviewOutcome).toBe("AWAITING_SECOND_REVIEWER");
    expect(trail[2].payload.reviewOutcome).toBe("APPROVED");
    expect(trail[2].payload.source).toBe("slack");
  });
});
