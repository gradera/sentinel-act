// graph-writer.test.ts (spec §10): commitProposal opens exactly one
// executeWrite call for an entire plan; on a thrown error mid-plan, no
// partial Cypher .run() calls happen outside that one transaction; the
// proposalId idempotency marker short-circuits a second call with the
// same proposalId (FR-12, FR-13, FR-15).
import { describe, expect, it } from "vitest";
import { GraphWriter } from "../../src/commit/graph-writer.js";
import { CommitError, ValidationError } from "../../src/errors.js";
import { createMockDriver, mockRecord, type RunHandler } from "../helpers/mock-driver.js";
import type { CommitPlan } from "../../src/types.js";

const obligationFixture = {
  obligation_id: "ob-1",
  derived_from_clause_id: "cl-1",
  category: "disclosure",
  requirement_text: "req",
  trigger_event: "trigger",
  deadline_rule: "T+5",
  responsible_role: "Compliance Officer",
  evidence_required: "log",
  penalty_ref: null,
  confidence_score: 0.9,
  grounding_score: 0.85,
  status: "proposed" as const,
  valid_from: "2026-01-01",
  valid_to: null
};

function buildHappyPlan(proposalId: string): CommitPlan {
  return {
    proposalId,
    nodes: { obligations: [obligationFixture] },
    edges: []
  };
}

function buildFailingPlan(proposalId: string): CommitPlan {
  return {
    proposalId,
    nodes: { obligations: [obligationFixture] },
    // DERIVED_FROM edge referencing a clause id that the mock handler
    // reports as not found (see handler below) — models Acceptance
    // Criterion 2's fault injection.
    edges: [{ type: "DERIVED_FROM", obligation_id: "ob-1", clause_id: "nonexistent-clause" }]
  };
}

/** Stateful handler: tracks whether a CommitLog marker has been written
 *  (in-memory, keyed by proposalId) so a second commitProposal call for
 *  the same proposalId can be asserted to short-circuit. `edgesSucceed`
 *  controls whether MATCH+CREATE edge calls report their endpoints found. */
function buildHandler(options: { edgesSucceed: boolean }): { handler: RunHandler; committedProposals: Map<string, string> } {
  const committedProposals = new Map<string, string>();

  const handler: RunHandler = (cypher, params) => {
    if (cypher.includes("MATCH (c:CommitLog {proposal_id: $proposalId}) RETURN c.result_json")) {
      const proposalId = params.proposalId as string;
      const cached = committedProposals.get(proposalId);
      return cached ? { records: [mockRecord({ resultJson: cached })] } : { records: [] };
    }
    if (cypher.startsWith("MERGE (c:CommitLog")) {
      committedProposals.set(params.proposalId as string, params.resultJson as string);
      return { records: [] };
    }
    if (cypher.startsWith("CREATE (n:Obligation)")) {
      return { records: [mockRecord({ n: { properties: { ...obligationFixture, recorded_at: "2026-01-01T00:00:00Z" } } })] };
    }
    if (cypher.includes("RETURN datetime() AS now")) {
      return { records: [mockRecord({ now: "2026-07-05T00:00:00Z" })] };
    }
    if (cypher.startsWith("MATCH (a:")) {
      return options.edgesSucceed ? { records: [mockRecord({ a: {}, b: {} })] } : { records: [] };
    }
    return { records: [] };
  };

  return { handler, committedProposals };
}

describe("GraphWriter.commitProposal", () => {
  it("opens exactly one session.executeWrite call for an entire plan", async () => {
    const { handler } = buildHandler({ edgesSucceed: true });
    const { driver, executeWriteCallCount } = createMockDriver(handler);
    const writer = new GraphWriter(driver);

    const result = await writer.commitProposal(buildHappyPlan("proposal-single-write"));

    expect(executeWriteCallCount()).toBe(1);
    expect(result.nodeCounts.Obligation).toBe(1);
    expect(result.proposalId).toBe("proposal-single-write");
  });

  it("validates before opening any transaction — ValidationError, zero executeWrite calls", async () => {
    const { handler } = buildHandler({ edgesSucceed: true });
    const { driver, executeWriteCallCount } = createMockDriver(handler);
    const writer = new GraphWriter(driver);

    const malformedPlan = {
      ...buildHappyPlan("proposal-invalid"),
      nodes: { obligations: [{ ...obligationFixture, confidence_score: 1.5 }] }
    };

    await expect(writer.commitProposal(malformedPlan as CommitPlan)).rejects.toBeInstanceOf(ValidationError);
    expect(executeWriteCallCount()).toBe(0);
  });

  it("wraps a mid-plan failure (missing edge endpoint) in CommitError; only one transaction was ever opened", async () => {
    const { handler } = buildHandler({ edgesSucceed: false });
    const { driver, executeWriteCallCount, sessionCallCount } = createMockDriver(handler);
    const writer = new GraphWriter(driver);

    await expect(writer.commitProposal(buildFailingPlan("proposal-fails"))).rejects.toBeInstanceOf(CommitError);

    // Exactly one session was opened and exactly one executeWrite attempt
    // was made — nothing partially ran outside that single transaction
    // context (Acceptance Criterion 2).
    expect(sessionCallCount()).toBe(1);
    expect(executeWriteCallCount()).toBe(1);
  });

  it("is idempotent per proposalId: a second call short-circuits and returns the cached CommitResult", async () => {
    const { handler } = buildHandler({ edgesSucceed: true });
    const { driver, executeWriteCallCount } = createMockDriver(handler);
    const writer = new GraphWriter(driver);
    const plan = buildHappyPlan("proposal-idempotent");

    const first = await writer.commitProposal(plan);
    const second = await writer.commitProposal(plan);

    expect(second).toEqual(first);
    // Both calls still go through executeWrite (the idempotency check
    // itself runs inside the transaction, per FR-15's "in the same
    // transaction as a successful prior commit" design) — but the second
    // call's CommitLog MATCH short-circuits before any node/edge writes,
    // which we verify indirectly via the identical, non-incremented result.
    expect(executeWriteCallCount()).toBe(2);
    expect(second.committedAt).toBe(first.committedAt);
  });
});
