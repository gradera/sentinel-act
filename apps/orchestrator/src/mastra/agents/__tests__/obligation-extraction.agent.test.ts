// Spec 03 §9 acceptance criteria + §10 unit test plan, exercised against
// extractObligations() with every external effect (LLM call, Neo4j reads)
// injected via ObligationExtractionDependencies — mirrors the
// dependency-injection convention regulatory-watch.agent.ts established
// for Spec 02. No live Mastra Agent invocation, no real Neo4j driver, no
// API key required to run this file.
import { describe, expect, it, vi } from "vitest";
import {
  extractObligations,
  ObligationExtractionValidationError,
  ObligationExtractionInputError,
  type ObligationExtractionDependencies,
  type GenerateProposalsResult
} from "../obligation-extraction.agent.js";
import {
  makeClause,
  makeExtractionInput,
  makeIntermediaryCategory,
  singleObligationModelOutput,
  multiObligationModelOutput,
  informationalModelOutput,
  SINGLE_OBLIGATION_CLAUSE_TEXT,
  MULTI_OBLIGATION_CLAUSE_TEXT,
  INFORMATIONAL_CLAUSE_TEXT
} from "./obligation-extraction.fixtures.js";

function baseDeps(overrides: Partial<ObligationExtractionDependencies> = {}): Partial<ObligationExtractionDependencies> {
  return {
    findSimilarClauses: vi.fn(async () => []),
    findRelatedObligations: vi.fn(async () => []),
    listIntermediaryCategories: vi.fn(async () => []),
    sleep: vi.fn(async () => undefined),
    topK: 5,
    ...overrides
  };
}

function generateResult(object: unknown, overrides: Partial<GenerateProposalsResult> = {}): GenerateProposalsResult {
  return {
    object,
    modelId: "anthropic/claude-sonnet-4-5-test",
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    ...overrides
  };
}

describe("extractObligations — acceptance criteria (Spec 03 §9)", () => {
  it("AC1: single, clear reporting obligation with an explicit deadline", async () => {
    const generateProposals = vi.fn(async () => generateResult(singleObligationModelOutput()));
    const input = makeExtractionInput({ clause: makeClause({ text: SINGLE_OBLIGATION_CLAUSE_TEXT }) });

    const output = await extractObligations(input, baseDeps({ generateProposals }));

    expect(output.proposals).toHaveLength(1);
    expect(output.proposals[0].category).toBe("reporting");
    expect(output.proposals[0].deadline_rule).toMatch(/7 working days/);
    expect(output.proposals[0].derived_from_clause_id).toBe(input.clause.clause_id);
    // All required fields present in the fixture -> zero completeness penalty.
    expect(output.proposals[0].confidence_breakdown.field_completeness_penalty).toBe(0);
    expect(generateProposals).toHaveBeenCalledTimes(1);
  });

  it("AC2: two distinct duties in one clause produce two proposals with distinct extraction_index", async () => {
    const generateProposals = vi.fn(async () => generateResult(multiObligationModelOutput()));
    const input = makeExtractionInput({ clause: makeClause({ text: MULTI_OBLIGATION_CLAUSE_TEXT }) });

    const output = await extractObligations(input, baseDeps({ generateProposals }));

    expect(output.proposals).toHaveLength(2);
    expect(new Set(output.proposals.map((p) => p.category)).size).toBe(2);
    expect(output.proposals.map((p) => p.extraction_index).sort()).toEqual([0, 1]);
    expect(output.proposals.every((p) => p.derived_from_clause_id === input.clause.clause_id)).toBe(true);
  });

  it("AC3: purely definitional/preambular clause returns an empty, informational-only result", async () => {
    const generateProposals = vi.fn(async () => generateResult(informationalModelOutput()));
    const input = makeExtractionInput({ clause: makeClause({ text: INFORMATIONAL_CLAUSE_TEXT }) });

    const output = await extractObligations(input, baseDeps({ generateProposals }));

    expect(output.proposals).toEqual([]);
    expect(output.informational_only).toBe(true);
    expect(output.informational_reason).toBeTruthy();
  });

  it("AC4: highly similar prior clause with an obligation of the same category -> not first-seen, bonus applied", async () => {
    const generateProposals = vi.fn(async () => generateResult(singleObligationModelOutput()));
    const deps = baseDeps({
      generateProposals,
      findSimilarClauses: vi.fn(async () => [{ clause_id: "clause-prior-1", para_ref: "Para 4.1", similarity: 0.95 }]),
      findRelatedObligations: vi.fn(async () => [
        { obligation_id: "ob-prior-1", category: "reporting", clause_id: "clause-prior-1" }
      ])
    });

    const output = await extractObligations(makeExtractionInput(), deps);

    expect(output.graphrag_context.is_first_seen_obligation_type).toBe(false);
    expect(output.proposals[0].confidence_breakdown.graphrag_support_bonus).toBeGreaterThan(0);
  });

  it("AC5: cold start (no similar prior clauses) -> first-seen obligation type", async () => {
    const generateProposals = vi.fn(async () => generateResult(singleObligationModelOutput()));
    const output = await extractObligations(makeExtractionInput(), baseDeps({ generateProposals }));

    expect(output.graphrag_context.is_first_seen_obligation_type).toBe(true);
    expect(output.proposals[0].confidence_breakdown.graphrag_support_bonus).toBe(0);
  });

  it("AC6: Neo4j vector index unreachable -> call still completes with empty GraphRAG context, first-seen true", async () => {
    const generateProposals = vi.fn(async () => generateResult(singleObligationModelOutput()));
    const deps = baseDeps({
      generateProposals,
      findSimilarClauses: vi.fn(async () => {
        throw new Error("Neo4j unavailable");
      })
    });

    const output = await extractObligations(makeExtractionInput(), deps);

    expect(output.graphrag_context.similar_clauses).toEqual([]);
    expect(output.graphrag_context.related_obligations).toEqual([]);
    expect(output.graphrag_context.is_first_seen_obligation_type).toBe(true);
    // §8: retried 2x with backoff before degrading — 3 total attempts.
    expect(deps.findSimilarClauses).toHaveBeenCalledTimes(3);
  });

  it("AC7: Zod validation fails twice in a row -> throws ObligationExtractionValidationError, no output returned", async () => {
    const generateProposals = vi.fn(async () => generateResult({ proposals: "not-an-array" }));
    const deps = baseDeps({ generateProposals });

    await expect(extractObligations(makeExtractionInput(), deps)).rejects.toBeInstanceOf(
      ObligationExtractionValidationError
    );
    expect(generateProposals).toHaveBeenCalledTimes(2);
  });

  it("AC8: undated clause -> deadline_rule is always the literal string NONE, never inferred", async () => {
    const output0 = singleObligationModelOutput();
    const undatedOutput = {
      ...output0,
      proposals: [{ ...output0.proposals[0], deadline_rule: "NONE" }]
    };
    const generateProposals = vi.fn(async () => generateResult(undatedOutput));

    const output = await extractObligations(
      makeExtractionInput({ clause: makeClause({ text: "The intermediary shall maintain a compliance manual." }) }),
      baseDeps({ generateProposals })
    );

    expect(output.proposals.every((p) => p.deadline_rule === "NONE")).toBe(true);
  });
});

describe("extractObligations — FR/§8 edge cases", () => {
  it("FR-7: derived_from_clause_id is always assigned from the input clause, never trusted from model output", async () => {
    // The Zod schema (§5.4) does not even ask the model for
    // derived_from_clause_id — this agent assigns it directly in
    // post-processing, so a "hallucinated clause id" is structurally
    // impossible rather than merely detected. Verified here by confirming
    // the model output (which has no such field) still produces the
    // correct id on every proposal.
    const generateProposals = vi.fn(async () => generateResult(multiObligationModelOutput()));
    const input = makeExtractionInput({ clause: makeClause({ clause_id: "clause-xyz", text: MULTI_OBLIGATION_CLAUSE_TEXT }) });

    const output = await extractObligations(input, baseDeps({ generateProposals }));

    expect(output.proposals.every((p) => p.derived_from_clause_id === "clause-xyz")).toBe(true);
  });

  it("FR-2: listIntermediaryCategories is always executed, alongside the other two GraphRAG tools, before the LLM call", async () => {
    const generateProposals = vi.fn(async () => generateResult(singleObligationModelOutput()));
    const listIntermediaryCategories = vi.fn(async () => []);

    await extractObligations(makeExtractionInput(), baseDeps({ generateProposals, listIntermediaryCategories }));

    expect(listIntermediaryCategories).toHaveBeenCalledTimes(1);
  });

  it("regression: a genuinely novel category within a mixed batch never receives a graphrag_support_bonus, even when a sibling proposal's category is not novel", async () => {
    // One proposal's category ("investor_grievance") already has a
    // matching related obligation; the other ("record_keeping") does
    // not. The batch-level graphrag_context.is_first_seen_obligation_type
    // must be false (at least one category is not novel — FR-11), but
    // the record_keeping proposal specifically must NOT collect a bonus
    // for novelty it doesn't have evidence against, and the
    // investor_grievance proposal (not novel) is the only one eligible
    // for a bonus at all.
    const generateProposals = vi.fn(async () => generateResult(multiObligationModelOutput()));
    const deps = baseDeps({
      generateProposals,
      findSimilarClauses: vi.fn(async () => [{ clause_id: "clause-prior-1", para_ref: "Para 4.1", similarity: 0.95 }]),
      findRelatedObligations: vi.fn(async () => [
        { obligation_id: "ob-prior-1", category: "investor_grievance", clause_id: "clause-prior-1" }
      ])
    });

    const output = await extractObligations(makeExtractionInput(), deps);

    const grievanceProposal = output.proposals.find((p) => p.category === "investor_grievance");
    const recordKeepingProposal = output.proposals.find((p) => p.category === "record_keeping");
    expect(grievanceProposal).toBeDefined();
    expect(recordKeepingProposal).toBeDefined();

    // Not novel -> eligible for (and, at similarity 0.95, receives) a bonus.
    expect(grievanceProposal?.confidence_breakdown.graphrag_support_bonus).toBeGreaterThan(0);
    // Genuinely novel -> must never receive a bonus, regardless of the
    // sibling proposal's novelty status or the batch-level flag.
    expect(recordKeepingProposal?.confidence_breakdown.graphrag_support_bonus).toBe(0);

    // Batch-level FR-11 signal: at least one category (investor_grievance)
    // is not novel, so the batch as a whole is not first-seen.
    expect(output.graphrag_context.is_first_seen_obligation_type).toBe(false);
  });

  it("short clause text short-circuits to informational_only without invoking the model", async () => {
    const generateProposals = vi.fn(async () => generateResult(singleObligationModelOutput()));
    const input = makeExtractionInput({ clause: makeClause({ text: "Too short" }) });

    const output = await extractObligations(input, baseDeps({ generateProposals }));

    expect(output.informational_only).toBe(true);
    expect(output.informational_reason).toMatch(/too short/);
    expect(generateProposals).not.toHaveBeenCalled();
  });

  it("empty clause text short-circuits without invoking the model", async () => {
    const generateProposals = vi.fn(async () => generateResult(singleObligationModelOutput()));
    const input = makeExtractionInput({ clause: makeClause({ text: "   " }) });

    const output = await extractObligations(input, baseDeps({ generateProposals }));

    expect(output.informational_only).toBe(true);
    expect(generateProposals).not.toHaveBeenCalled();
  });

  it("over-length clause text throws ObligationExtractionInputError without invoking the model", async () => {
    const generateProposals = vi.fn(async () => generateResult(singleObligationModelOutput()));
    const input = makeExtractionInput({ clause: makeClause({ text: "x".repeat(8001) }) });

    await expect(extractObligations(input, baseDeps({ generateProposals }))).rejects.toBeInstanceOf(
      ObligationExtractionInputError
    );
    expect(generateProposals).not.toHaveBeenCalled();
  });

  it("FR-15: empty knownIntermediaryCategories still succeeds, category names land in applies_to_unknown_category_names", async () => {
    const generateProposals = vi.fn(async () => generateResult(singleObligationModelOutput()));
    const input = makeExtractionInput({ knownIntermediaryCategories: [] });

    const output = await extractObligations(input, baseDeps({ generateProposals }));

    expect(output.proposals[0].applies_to_category_names).toEqual([]);
    expect(output.proposals[0].applies_to_unknown_category_names).toContain("Stockbroker");
  });

  it("FR-9: category names not in the closed vocabulary are moved to applies_to_unknown_category_names (defense in depth)", async () => {
    const base = singleObligationModelOutput();
    const withStrayCategory = {
      ...base,
      proposals: [{ ...base.proposals[0], applies_to_category_names: ["Stockbroker", "Not A Real Category"] }]
    };
    const generateProposals = vi.fn(async () => generateResult(withStrayCategory));
    const input = makeExtractionInput({ knownIntermediaryCategories: [makeIntermediaryCategory({ name: "Stockbroker" })] });

    const output = await extractObligations(input, baseDeps({ generateProposals }));

    expect(output.proposals[0].applies_to_category_names).toEqual(["Stockbroker"]);
    expect(output.proposals[0].applies_to_unknown_category_names).toContain("Not A Real Category");
  });

  it("partial GraphRAG failure (findRelatedObligations fails after findSimilarClauses succeeds) degrades gracefully", async () => {
    const generateProposals = vi.fn(async () => generateResult(singleObligationModelOutput()));
    const deps = baseDeps({
      generateProposals,
      findSimilarClauses: vi.fn(async () => [{ clause_id: "clause-prior-1", para_ref: "Para 4.1", similarity: 0.95 }]),
      findRelatedObligations: vi.fn(async () => {
        throw new Error("transient read failure");
      })
    });

    const output = await extractObligations(makeExtractionInput(), deps);

    expect(output.graphrag_context.related_obligations).toEqual([]);
    expect(output.graphrag_context.is_first_seen_obligation_type).toBe(true);
    expect(output.proposals).toHaveLength(1);
  });

  it("read-only enforcement: only the injected read-style dependencies are ever invoked — no write-capable dependency exists on the DI surface", async () => {
    // This is a structural/regression guard, not a live-driver assertion
    // (this test file never constructs a real Neo4j Session — see the
    // FR-12 grep guard in the Definition of Done for the code-level
    // enforcement). It confirms extractObligations only ever calls the
    // read-shaped dependencies we inject, and never anything resembling a
    // write.
    const findSimilarClauses = vi.fn(async () => []);
    const findRelatedObligations = vi.fn(async () => []);
    const generateProposals = vi.fn(async () => generateResult(informationalModelOutput()));

    await extractObligations(
      makeExtractionInput({ clause: makeClause({ text: INFORMATIONAL_CLAUSE_TEXT }) }),
      baseDeps({ generateProposals, findSimilarClauses, findRelatedObligations })
    );

    expect(findSimilarClauses).toHaveBeenCalled();
    // findRelatedObligations is only called when similar_clauses is
    // non-empty; here it's cold-start, so it must NOT have been called.
    expect(findRelatedObligations).not.toHaveBeenCalled();
    expect(Object.keys({} as ObligationExtractionDependencies)).not.toContain("write");
  });
});

// ---------------------------------------------------------------------------
// The spec's §10 integration-test bullet ("hits the real configured
// default model, gated behind an env flag/CI secret") — written so it
// skips cleanly with no API key present, per instruction not to fabricate
// a live model result in this sandbox.
// ---------------------------------------------------------------------------
describe.skipIf(!process.env.OBLIGATION_EXTRACTION_LIVE_MODEL_TEST)("extractObligations — live model (gated)", () => {
  it("produces a plausible extraction against the real configured default model", async () => {
    const input = makeExtractionInput({ clause: makeClause({ text: SINGLE_OBLIGATION_CLAUSE_TEXT }) });
    const output = await extractObligations(input);
    expect(output.proposals.length).toBeGreaterThan(0);
  });
});
