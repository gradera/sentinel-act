// End-to-end (fake-graph, mocked-alignment) tests for computeChangeProposal
// — the Spec 06 §9 Acceptance Criteria 1-7, plus FR-25/26/27 assembly and
// the FR-13/FR-14 alignment gating. These stand in for the §10 "real Neo4j"
// integration tests where no live database is reachable (the graph read
// surface is exercised through an in-memory fake with identical semantics).
import { describe, it, expect } from "vitest";
import { computeChangeProposal } from "../change-and-delta.core.js";
import { ChangeAndDeltaNotApplicableError, ChangeAndDeltaStaleTargetError } from "../change-and-delta.errors.js";
import type { Clause, Obligation, ProcessTask } from "@sentinel-act/graph-schema";
import type { ChangeAndDeltaInput } from "../change-and-delta.types.js";
import {
  triggerEvent,
  amendmentContext,
  amendmentCircularCandidate,
  clauseCandidate,
  upstreamResult,
  proposal,
  extraction,
  makeCuspaGraph,
  makeFakeGraph,
  makeAlignPort,
  neverCalledAlignPort,
  oldMasterCircular,
  oldClause46,
  oldObligation,
  oldTask,
  OLD_46_TEXT,
  OLD_CIRCULAR_ID,
  AMEND_CLAUSE_ID,
  AMEND_CIRCULAR_ID
} from "./change-and-delta.fixtures.js";

describe("computeChangeProposal — AC1 flagship CUSPA happy path", () => {
  it("produces exactly one supersession via the deterministic path, no LLM call", async () => {
    const input: ChangeAndDeltaInput = {
      triggerEvent: triggerEvent(),
      upstreamResults: [upstreamResult()],
      referenceDate: "2026-07-03"
    };
    const align = neverCalledAlignPort();
    const result = await computeChangeProposal(input, makeCuspaGraph(), align);

    expect(result.scope).toBe("paragraph_amendment");
    expect(result.supersessions).toHaveLength(1);
    expect(result.supersessions[0].oldObligationId).toBe("obl-cuspa-old");
    expect(result.circularSupersession).toBeNull();
    expect(result.unresolvedAlignments).toEqual([]);
    expect(result.usedLlmAlignment).toBe(false);
    expect(align.calls).toHaveLength(0);
    expect(result.triggerEventId).toBe("evt-cuspa-001");
    expect(result.effectiveDate).toBe("2026-07-03");

    const redline = result.supersessions[0].redline;
    const byField = Object.fromEntries(redline.fields.map((f) => [f.field, f.status]));
    expect(byField.sla_hours).toBe("changed");
    expect(byField.risk_score).toBe("changed");
    expect(byField.owner_role).toBe("unchanged");
    expect(byField.system_touchpoint).toBe("unchanged");
    expect(redline.overallStatus).toBe("modified");
    expect(redline.oldTaskId).toBe("task-cuspa-old");

    // FR-25 — min(0.9 amendmentContext, 0.95 alignment, 0.88 proposal) = 0.88.
    expect(result.overallConfidence).toBeCloseTo(0.88, 10);
    // redlines flattened from supersessions + additions.
    expect(result.redlines).toHaveLength(1);
  });
});

describe("computeChangeProposal — AC2 cosmetic republish is not a false-positive", () => {
  it("classifies a near-identical clause as unaffected", async () => {
    const cosmeticText = `Paragraph 46 is amended to read as follows: '${OLD_46_TEXT}'`;
    const input: ChangeAndDeltaInput = {
      triggerEvent: triggerEvent({
        clauses: [clauseCandidate(AMEND_CLAUSE_ID, AMEND_CIRCULAR_ID, "1", cosmeticText)]
      }),
      upstreamResults: [upstreamResult({ clauseCandidate: clauseCandidate(AMEND_CLAUSE_ID, AMEND_CIRCULAR_ID, "1", cosmeticText) })],
      referenceDate: "2026-07-03"
    };
    const result = await computeChangeProposal(input, makeCuspaGraph(), neverCalledAlignPort());

    expect(result.supersessions).toHaveLength(0);
    expect(result.diffEntries).toHaveLength(1);
    expect(result.diffEntries[0].action).toBe("unaffected");
    expect(result.diffEntries[0].clauseDiff.materiality).toBe("unchanged");
  });
});

describe("computeChangeProposal — AC3 newly added paragraph", () => {
  it("classifies an inserted paragraph as newly_added with a new-task redline", async () => {
    const addText =
      "Paragraph 46A shall be inserted and shall read as follows: '46A. A stock broker shall maintain a daily " +
      "reconciliation log of all client unpaid securities and submit it to the exchange by end of day.'";
    const clause = clauseCandidate(AMEND_CLAUSE_ID, AMEND_CIRCULAR_ID, "1", addText);
    const input: ChangeAndDeltaInput = {
      triggerEvent: triggerEvent({
        clauses: [clause],
        amendmentContext: amendmentContext({ amendedParaRefs: ["46A"] })
      }),
      upstreamResults: [
        upstreamResult({
          clauseCandidate: clause,
          extraction: extraction([proposal({ derived_from_clause_id: AMEND_CLAUSE_ID })])
        })
      ],
      referenceDate: "2026-07-03"
    };
    const result = await computeChangeProposal(input, makeCuspaGraph(), neverCalledAlignPort());

    expect(result.additions).toHaveLength(1);
    expect(result.supersessions).toHaveLength(0);
    expect(result.diffEntries[0].action).toBe("newly_added");
    expect(result.diffEntries[0].oldObligation).toBeNull();
    expect(result.additions[0].redline.oldTaskId).toBeNull();
    expect(result.additions[0].redline.overallStatus).toBe("new");
  });
});

describe("computeChangeProposal — AC4 ambiguous amendment forces escalation", () => {
  it("surfaces one unresolved alignment (below threshold) and no supersession, without throwing", async () => {
    const noMarkerText = "Paragraph 46 now provides different handling for client unpaid securities in certain scenarios.";
    const clause = clauseCandidate(AMEND_CLAUSE_ID, AMEND_CIRCULAR_ID, "1", noMarkerText);
    const input: ChangeAndDeltaInput = {
      triggerEvent: triggerEvent({ clauses: [clause] }),
      upstreamResults: [upstreamResult({ clauseCandidate: clause })],
      referenceDate: "2026-07-03"
    };
    const align = makeAlignPort({ "46": { matchedText: "aligned but uncertain text", confidence: 0.4 } });
    const result = await computeChangeProposal(input, makeCuspaGraph(), align);

    expect(result.unresolvedAlignments).toHaveLength(1);
    expect(result.unresolvedAlignments[0].paraRef).toBe("46");
    expect(result.unresolvedAlignments[0].reason).toBe("llm_confidence_below_threshold");
    expect(result.supersessions).toHaveLength(0);
    expect(align.calls).toHaveLength(1);
  });

  it("degrades a provider error to an unresolved alignment (FR-14), never throws", async () => {
    const noMarkerText = "Paragraph 46 now provides different handling for client unpaid securities in certain scenarios.";
    const clause = clauseCandidate(AMEND_CLAUSE_ID, AMEND_CIRCULAR_ID, "1", noMarkerText);
    const input: ChangeAndDeltaInput = {
      triggerEvent: triggerEvent({ clauses: [clause] }),
      upstreamResults: [upstreamResult({ clauseCandidate: clause })],
      referenceDate: "2026-07-03"
    };
    const align = makeAlignPort({}, { throwError: true });
    const result = await computeChangeProposal(input, makeCuspaGraph(), align);

    expect(result.unresolvedAlignments).toHaveLength(1);
    expect(result.unresolvedAlignments[0].reason).toBe("no_confident_deterministic_split");
    expect(result.supersessions).toHaveLength(0);
  });
});

describe("computeChangeProposal — AC5 full-document supersession with a genuine repeal", () => {
  it("repeals an old paragraph absent from the new circular and populates circularSupersession", async () => {
    const oldClause12: Clause = { ...oldClause46(), clause_id: "clause-12", para_ref: "12", text: "12. Old obligation about quarterly filings that the new circular drops entirely." };
    const oldObl12: Obligation = { ...oldObligation(), obligation_id: "obl-12", derived_from_clause_id: "clause-12" };
    const oldTask12: ProcessTask = { ...oldTask(), task_id: "task-12", obligation_id: "obl-12" };

    const newCircularId = "circ-masterbroker-2026";
    const graph = makeFakeGraph({
      circulars: [oldMasterCircular()],
      clauses: [oldClause46(), oldClause12],
      obligations: [oldObligation(), oldObl12],
      tasks: [oldTask(), oldTask12]
    });

    // New circular republishes para 46 unchanged; para 12 is gone.
    const newClause46 = clauseCandidate("new-46", newCircularId, "46", OLD_46_TEXT);
    const input: ChangeAndDeltaInput = {
      triggerEvent: triggerEvent({
        changeType: "amendment",
        amendmentContext: null,
        circular: amendmentCircularCandidate({ circular_id: newCircularId, supersedes_circular_id: OLD_CIRCULAR_ID }),
        clauses: [newClause46]
      }),
      upstreamResults: [],
      referenceDate: "2026-07-03"
    };
    // FR-17 renumbering check for para 12 finds no match -> confirmed repeal.
    const align = makeAlignPort({ "12": { matchedText: null, confidence: 0.95 } });
    const result = await computeChangeProposal(input, graph, align);

    expect(result.scope).toBe("full_document_supersession");
    expect(result.repeals).toHaveLength(1);
    expect(result.repeals[0].oldObligationId).toBe("obl-12");
    expect(result.circularSupersession).not.toBeNull();
    expect(result.circularSupersession!.oldCircularId).toBe(OLD_CIRCULAR_ID);
    expect(result.circularSupersession!.newCircularId).toBe(newCircularId);
    expect(result.diffEntries.some((e) => e.action === "repealed" && e.clauseDiff.paraRef === "12")).toBe(true);
  });
});

describe("computeChangeProposal — AC6 contradictory proposal is excluded, not diffed", () => {
  it("excludes a contradictory proposal from supersessions but still logs the diff entry", async () => {
    const input: ChangeAndDeltaInput = {
      triggerEvent: triggerEvent(),
      upstreamResults: [upstreamResult({ mappingResults: [null], contradictionFlags: [true] })],
      referenceDate: "2026-07-03"
    };
    const result = await computeChangeProposal(input, makeCuspaGraph(), neverCalledAlignPort());

    expect(result.supersessions).toHaveLength(0);
    expect(result.additions).toHaveLength(0);
    expect(result.diffEntries).toHaveLength(1);
    expect(result.diffEntries[0].newObligationProposal).toBeNull();
    expect(result.diffEntries[0].rationale).toContain("contradictor");
  });
});

describe("computeChangeProposal — AC7 stale target circular", () => {
  it("throws ChangeAndDeltaStaleTargetError when the target circular is no longer live", async () => {
    const staleGraph = makeFakeGraph({
      circulars: [oldMasterCircular({ valid_to: "2026-06-30" })],
      clauses: [oldClause46()],
      obligations: [oldObligation()],
      tasks: [oldTask()]
    });
    const input: ChangeAndDeltaInput = {
      triggerEvent: triggerEvent(),
      upstreamResults: [upstreamResult()],
      referenceDate: "2026-07-03"
    };
    await expect(computeChangeProposal(input, staleGraph, neverCalledAlignPort())).rejects.toBeInstanceOf(
      ChangeAndDeltaStaleTargetError
    );
  });

  it("throws ChangeAndDeltaStaleTargetError when the target circular is missing", async () => {
    const emptyGraph = makeFakeGraph({});
    const input: ChangeAndDeltaInput = {
      triggerEvent: triggerEvent(),
      upstreamResults: [upstreamResult()],
      referenceDate: "2026-07-03"
    };
    await expect(computeChangeProposal(input, emptyGraph, neverCalledAlignPort())).rejects.toBeInstanceOf(
      ChangeAndDeltaStaleTargetError
    );
  });
});

describe("computeChangeProposal — FR-1 precondition", () => {
  it("throws ChangeAndDeltaNotApplicableError for a non-amendment trigger", async () => {
    const input: ChangeAndDeltaInput = {
      triggerEvent: triggerEvent({ amendmentContext: null }),
      upstreamResults: [],
      referenceDate: "2026-07-03"
    };
    await expect(computeChangeProposal(input, makeCuspaGraph(), neverCalledAlignPort())).rejects.toBeInstanceOf(
      ChangeAndDeltaNotApplicableError
    );
  });
});

describe("computeChangeProposal — FR-27 correlation ids", () => {
  it("stamps a fresh changeProposalId and echoes triggerEventId verbatim", async () => {
    const input: ChangeAndDeltaInput = {
      triggerEvent: triggerEvent(),
      upstreamResults: [upstreamResult()],
      referenceDate: "2026-07-03"
    };
    const a = await computeChangeProposal(input, makeCuspaGraph(), neverCalledAlignPort());
    const b = await computeChangeProposal(input, makeCuspaGraph(), neverCalledAlignPort());
    expect(a.changeProposalId).not.toBe(b.changeProposalId);
    expect(a.triggerEventId).toBe("evt-cuspa-001");
    expect(a.generatedAt).toBeDefined();
  });
});
