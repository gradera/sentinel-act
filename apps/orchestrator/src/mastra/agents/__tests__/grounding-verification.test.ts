// Spec 04 §9 acceptance criteria + §10 unit test plan.
//
// Two layers are covered here, both infra-free (no live Mastra Agent
// invocation, no real Neo4j driver, no API key required to run this
// file):
//
// 1. The pure scoring/validation functions (grounding-scoring.ts,
//    grounding-verification.schema.ts) — exercised directly.
// 2. verifyGrounding() end to end, with every external effect (LLM call,
//    contradiction lookup) injected via GroundingVerificationDependencies
//    — mirrors obligation-extraction.agent.test.ts's DI convention. This
//    is a faster, docker-free equivalent of several of Spec 04 §10's
//    "integration test" bullets (which additionally require a real Neo4j
//    test container — see grounding-verification.integration.test.ts for
//    those, run separately where Docker is available).
//
// contradictionLookupTool's Cypher param-binding is tested against a
// lightweight structural mock of neo4j-driver's Driver/Session/
// ManagedTransaction shape (no `neo4j-driver` import needed — see
// contradiction-lookup.tool.ts's own header on why it never imports that
// package directly).
import { describe, expect, it, vi } from "vitest";
import { scoreField, aggregateGroundingScore, classifyVerdict, FIELD_CASES, type FieldCase } from "../grounding-scoring.js";
import { satisfiesContradictionInvariant, contradictionInvariantSchema } from "../grounding-verification.schema.js";
import { runContradictionLookup, type ContradictionLookupParams } from "../../tools/contradiction-lookup.tool.js";
import {
  verifyGrounding,
  GroundingVerificationValidationError,
  GroundingVerificationProviderError,
  GroundingVerificationEmptyClauseError,
  type GroundingVerificationDependencies,
  type GenerateVerificationResult
} from "../grounding-verification.agent.js";
import {
  makeVerificationInput,
  makeCandidate,
  cleanPassModelOutput,
  fabricatedPenaltyRefModelOutput,
  droppedConditionModelOutput,
  contradictionModelOutput
} from "./grounding-verification.fixtures.js";
import type { FieldGroundingResult } from "../grounding-verification.types.js";

// ============================================================================
// scoreField() — FR-4 rubric, table-driven over every FieldCase.
// ============================================================================
describe("scoreField (FR-4 rubric)", () => {
  const expected: Record<FieldCase, number> = {
    directly_stated: 1.0,
    paraphrase: 0.85,
    dropped_condition: 0.4,
    fabricated: 0.0,
    legitimately_absent: 1.0
  };

  it.each(FIELD_CASES)("case %s -> %s", (fieldCase) => {
    expect(scoreField(fieldCase)).toBe(expected[fieldCase]);
  });
});

// ============================================================================
// aggregateGroundingScore() — FR-5/FR-7/FR-8.
// ============================================================================
function fieldResult(overrides: Partial<FieldGroundingResult>): FieldGroundingResult {
  return {
    field: "requirement_text",
    score: 1.0,
    fabricated: false,
    dropped_condition: false,
    supporting_spans: ["x"],
    rationale: "r",
    ...overrides
  };
}

describe("aggregateGroundingScore (FR-5/FR-7/FR-8)", () => {
  it("clean pass: unweighted mean across six fields", () => {
    const results = [
      fieldResult({ field: "requirement_text", score: 1.0 }),
      fieldResult({ field: "trigger_event", score: 1.0 }),
      fieldResult({ field: "deadline_rule", score: 0.85 }),
      fieldResult({ field: "responsible_role", score: 1.0 }),
      fieldResult({ field: "evidence_required", score: 0.85 }),
      fieldResult({ field: "penalty_ref", score: 1.0 })
    ];
    const mean = (1.0 + 1.0 + 0.85 + 1.0 + 0.85 + 1.0) / 6;
    expect(aggregateGroundingScore(results)).toBeCloseTo(mean, 10);
  });

  it("FR-7: a single fabricated field caps the aggregate at 0.4, overriding a higher raw mean", () => {
    const results = [
      fieldResult({ score: 1.0 }),
      fieldResult({ score: 1.0 }),
      fieldResult({ score: 1.0 }),
      fieldResult({ score: 1.0 }),
      fieldResult({ score: 1.0 }),
      fieldResult({ score: 0.0, fabricated: true })
    ];
    // Raw mean would be 5/6 ≈ 0.833 — must be capped at 0.4.
    expect(aggregateGroundingScore(results)).toBe(0.4);
  });

  it("FR-8: a single dropped-condition field caps the aggregate at 0.6, overriding a higher raw mean", () => {
    const results = [
      fieldResult({ score: 1.0 }),
      fieldResult({ score: 1.0 }),
      fieldResult({ score: 1.0 }),
      fieldResult({ score: 1.0 }),
      fieldResult({ score: 1.0 }),
      fieldResult({ score: 0.4, dropped_condition: true })
    ];
    // Raw mean would be (5 + 0.4)/6 ≈ 0.9 — must be capped at 0.6.
    expect(aggregateGroundingScore(results)).toBe(0.6);
  });

  it("cap precedence: when both a fabricated and a dropped-condition field are present, the stricter 0.4 fabricated cap wins", () => {
    const results = [
      fieldResult({ score: 1.0 }),
      fieldResult({ score: 1.0 }),
      fieldResult({ score: 1.0 }),
      fieldResult({ score: 1.0 }),
      fieldResult({ score: 0.4, dropped_condition: true }),
      fieldResult({ score: 0.0, fabricated: true })
    ];
    expect(aggregateGroundingScore(results)).toBe(0.4);
  });
});

// ============================================================================
// classifyVerdict() — FR-6 boundary-exact thresholds.
// ============================================================================
describe("classifyVerdict (FR-6, boundary-exact)", () => {
  it("0.75 exactly -> pass", () => expect(classifyVerdict(0.75)).toBe("pass"));
  it("above 0.75 -> pass", () => expect(classifyVerdict(0.9)).toBe("pass"));
  it("0.5 exactly -> borderline", () => expect(classifyVerdict(0.5)).toBe("borderline"));
  it("0.74999 -> borderline", () => expect(classifyVerdict(0.74999)).toBe("borderline"));
  it("0.4999 -> fail", () => expect(classifyVerdict(0.4999)).toBe("fail"));
  it("0.0 -> fail", () => expect(classifyVerdict(0)).toBe("fail"));
});

// ============================================================================
// FR-11 output-contract invariant.
// ============================================================================
describe("FR-11 output-contract invariant", () => {
  it("accepts contradiction: false with empty details", () => {
    expect(satisfiesContradictionInvariant({ contradiction: false, contradiction_details: [] })).toBe(true);
    expect(contradictionInvariantSchema.safeParse({ contradiction: false, contradiction_details: [] }).success).toBe(true);
  });

  it("accepts contradiction: true with non-empty details", () => {
    expect(satisfiesContradictionInvariant({ contradiction: true, contradiction_details: [{ foo: "bar" }] })).toBe(true);
    expect(contradictionInvariantSchema.safeParse({ contradiction: true, contradiction_details: [{ foo: "bar" }] }).success).toBe(true);
  });

  it("rejects a hand-built contradiction: true + empty contradiction_details payload", () => {
    const malformed = { contradiction: true, contradiction_details: [] };
    expect(satisfiesContradictionInvariant(malformed)).toBe(false);
    expect(contradictionInvariantSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects contradiction: false with non-empty contradiction_details (the inverse violation)", () => {
    const malformed = { contradiction: false, contradiction_details: [{ foo: "bar" }] };
    expect(satisfiesContradictionInvariant(malformed)).toBe(false);
    expect(contradictionInvariantSchema.safeParse(malformed).success).toBe(false);
  });
});

// ============================================================================
// contradictionLookupTool / runContradictionLookup — Cypher param-binding
// against a mocked Neo4j driver (assert on the params object, not a live
// DB), per §10.
// ============================================================================
interface MockRecord {
  get(key: string): unknown;
}

function mockRecord(data: Record<string, unknown>): MockRecord {
  return { get: (key: string) => data[key] };
}

function buildMockDriver(records: MockRecord[] = []) {
  const runCalls: Array<{ cypher: string; params: Record<string, unknown> }> = [];
  const tx = {
    run: vi.fn(async (cypher: string, params: Record<string, unknown> = {}) => {
      runCalls.push({ cypher, params });
      return { records };
    })
  };
  const session = {
    executeRead: vi.fn(async (work: (t: typeof tx) => unknown) => work(tx)),
    close: vi.fn(async () => undefined)
  };
  const driver = {
    session: vi.fn(() => session)
  };
  return { driver: driver as unknown as Parameters<typeof runContradictionLookup>[0], runCalls, session };
}

describe("runContradictionLookup — Cypher param-binding", () => {
  const params: ContradictionLookupParams = {
    responsible_role: "Stockbroker",
    category: "risk_management",
    trigger_event: "unpaid securities beyond T+X",
    exclude_obligation_id: null,
    as_of: "2026-07-05"
  };

  it("binds every FR-9 param exactly, including exclude_obligation_id: null", async () => {
    const { driver, runCalls } = buildMockDriver([]);

    await runContradictionLookup(driver, params);

    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].params).toEqual({
      responsible_role: "Stockbroker",
      category: "risk_management",
      trigger_event: "unpaid securities beyond T+X",
      exclude_obligation_id: null,
      as_of: "2026-07-05"
    });
    expect(runCalls[0].cypher).toContain('o.status IN ["tier_a_committed", "committed"]');
    expect(runCalls[0].cypher).not.toMatch(/CREATE|MERGE|\bSET\b|DELETE/);
  });

  it("passes a non-null exclude_obligation_id through for re-verification runs", async () => {
    const { driver, runCalls } = buildMockDriver([]);

    await runContradictionLookup(driver, { ...params, exclude_obligation_id: "ob-stale-proposal" });

    expect(runCalls[0].params.exclude_obligation_id).toBe("ob-stale-proposal");
  });

  it("maps returned records onto ContradictionCandidateSchema", async () => {
    const { driver } = buildMockDriver([
      mockRecord({
        obligation_id: "ob-live-1",
        category: "risk_management",
        requirement_text: "req",
        trigger_event: "trig",
        deadline_rule: "within 3 calendar days",
        responsible_role: "Stockbroker",
        penalty_ref: null,
        status: "committed",
        source_para_ref: "Para 2.1",
        source_circular_title: "Master Circular"
      })
    ]);

    const results = await runContradictionLookup(driver, params);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ obligation_id: "ob-live-1", deadline_rule: "within 3 calendar days" });
  });

  it("always closes the session, even when the read throws", async () => {
    const { driver, session } = buildMockDriver([]);
    session.executeRead.mockRejectedValueOnce(new Error("boom"));

    await expect(runContradictionLookup(driver, params)).rejects.toThrow("boom");
    expect(session.close).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// verifyGrounding() — Spec 04 §9 acceptance criteria, via DI (no live
// infra). Mirrors obligation-extraction.agent.test.ts's structure.
// ============================================================================
function baseDeps(overrides: Partial<GroundingVerificationDependencies> = {}): Partial<GroundingVerificationDependencies> {
  return {
    lookupContradictionCandidates: vi.fn(async () => []),
    sleep: vi.fn(async () => undefined),
    ...overrides
  };
}

function generateResult(object: unknown, overrides: Partial<GenerateVerificationResult> = {}): GenerateVerificationResult {
  return {
    object,
    modelId: "anthropic/claude-opus-4-6-test",
    usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
    ...overrides
  };
}

describe("verifyGrounding — acceptance criteria (Spec 04 §9)", () => {
  it("AC1: faithful extraction, no fabrication, no dropped conditions, no live conflict -> pass, contradiction false", async () => {
    const generateVerification = vi.fn(async () => generateResult(cleanPassModelOutput()));
    const output = await verifyGrounding(makeVerificationInput(), baseDeps({ generateVerification }));

    expect(output.grounding_score).toBeGreaterThanOrEqual(0.85);
    expect(output.verdict).toBe("pass");
    expect(output.field_results.every((f) => f.fabricated === false)).toBe(true);
    expect(output.contradiction).toBe(false);
  });

  it("AC2: fabricated penalty_ref caps grounding_score at 0.4 and forces verdict fail", async () => {
    const generateVerification = vi.fn(async () => generateResult(fabricatedPenaltyRefModelOutput()));
    const output = await verifyGrounding(makeVerificationInput(), baseDeps({ generateVerification }));

    const penaltyResult = output.field_results.find((f) => f.field === "penalty_ref");
    expect(penaltyResult?.fabricated).toBe(true);
    expect(penaltyResult?.score).toBe(0.0);
    expect(output.grounding_score).toBeLessThanOrEqual(0.4);
    expect(output.verdict).toBe("fail");
  });

  it("AC3: dropped-condition deadline_rule caps grounding_score at 0.6 and verdict is never pass", async () => {
    const generateVerification = vi.fn(async () => generateResult(droppedConditionModelOutput()));
    const output = await verifyGrounding(makeVerificationInput(), baseDeps({ generateVerification }));

    const deadlineResult = output.field_results.find((f) => f.field === "deadline_rule");
    expect(deadlineResult?.dropped_condition).toBe(true);
    expect(output.grounding_score).toBeLessThanOrEqual(0.6);
    expect(["borderline", "fail"]).toContain(output.verdict);
  });

  it("AC4: a genuinely conflicting live Obligation produces exactly one contradiction_details entry with a specific explanation", async () => {
    const candidate = makeCandidate({ obligation_id: "ob-live-1", deadline_rule: "within 3 calendar days" });
    const generateVerification = vi.fn(async () => generateResult(contradictionModelOutput("ob-live-1")));
    const output = await verifyGrounding(
      makeVerificationInput(),
      baseDeps({ generateVerification, lookupContradictionCandidates: vi.fn(async () => [candidate]) })
    );

    expect(output.contradiction).toBe(true);
    expect(output.contradiction_details).toHaveLength(1);
    expect(output.contradiction_details[0]).toMatchObject({
      conflicting_obligation_id: "ob-live-1",
      divergent_field: "deadline_rule",
      proposed_value: "within 5 business days",
      existing_value: "within 3 calendar days"
    });
    expect(output.contradiction_details[0].explanation).not.toBe("conflict detected");
    expect(output.contradiction_details[0].explanation.length).toBeGreaterThan(15);
  });

  it("AC5: LLM provider fails on both the initial call and the retry -> GroundingVerificationProviderError, no output returned", async () => {
    const generateVerification = vi.fn(async () => {
      throw new Error("provider timeout");
    });
    const sleep = vi.fn(async () => undefined);

    await expect(verifyGrounding(makeVerificationInput(), baseDeps({ generateVerification, sleep }))).rejects.toBeInstanceOf(
      GroundingVerificationProviderError
    );
    expect(generateVerification).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("AC6: empty Clause.text -> agent is never invoked, throws GroundingVerificationEmptyClauseError", async () => {
    const generateVerification = vi.fn(async () => generateResult(cleanPassModelOutput()));
    const input = makeVerificationInput({ source: { ...makeVerificationInput().source, clause: { ...makeVerificationInput().source.clause, text: "   " } } });

    await expect(verifyGrounding(input, baseDeps({ generateVerification }))).rejects.toBeInstanceOf(GroundingVerificationEmptyClauseError);
    expect(generateVerification).not.toHaveBeenCalled();
  });

  it("AC7: a topically-similar-but-compatible candidate is not flagged (no false positive purely on trigger_event overlap)", async () => {
    const conflicting = makeCandidate({ obligation_id: "ob-live-conflict" });
    const nonConflicting = makeCandidate({ obligation_id: "ob-live-compatible", category: "risk_management" });
    const generateVerification = vi.fn(async () => generateResult(contradictionModelOutput("ob-live-conflict", "ob-live-compatible")));

    const output = await verifyGrounding(
      makeVerificationInput(),
      baseDeps({ generateVerification, lookupContradictionCandidates: vi.fn(async () => [conflicting, nonConflicting]) })
    );

    expect(output.contradiction_details).toHaveLength(1);
    expect(output.contradiction_details[0].conflicting_obligation_id).toBe("ob-live-conflict");
  });
});

describe("verifyGrounding — §8 error handling / edge cases", () => {
  it("retries once on malformed model output, then succeeds", async () => {
    const generateVerification = vi
      .fn()
      .mockResolvedValueOnce(generateResult({ not: "valid" }))
      .mockResolvedValueOnce(generateResult(cleanPassModelOutput()));

    const output = await verifyGrounding(makeVerificationInput(), baseDeps({ generateVerification }));

    expect(generateVerification).toHaveBeenCalledTimes(2);
    expect(output.verdict).toBe("pass");
  });

  it("throws GroundingVerificationValidationError when the model output fails schema validation twice in a row", async () => {
    const generateVerification = vi.fn(async () => generateResult({ not: "valid" }));

    await expect(verifyGrounding(makeVerificationInput(), baseDeps({ generateVerification }))).rejects.toBeInstanceOf(
      GroundingVerificationValidationError
    );
    expect(generateVerification).toHaveBeenCalledTimes(2);
  });

  it("Neo4j unavailable during contradiction lookup: grounding half still completes, contradiction forced false, verdict capped at borderline", async () => {
    const generateVerification = vi.fn(async () => generateResult(cleanPassModelOutput()));
    const lookupContradictionCandidates = vi.fn(async () => {
      throw new Error("Neo4j unavailable");
    });

    const output = await verifyGrounding(makeVerificationInput(), baseDeps({ generateVerification, lookupContradictionCandidates }));

    expect(output.contradiction).toBe(false);
    expect(output.contradiction_details).toEqual([]);
    // Would otherwise be "pass" per AC1's clean fixture — forced down
    // because the contradiction check could not run at all.
    expect(output.verdict).toBe("borderline");
    expect(output.summary).toMatch(/skipped/i);
  });

  it("FR-9: as_of falls back to today's date when circular.date_effective is null", async () => {
    const generateVerification = vi.fn(async () => generateResult(cleanPassModelOutput()));
    const lookupContradictionCandidates = vi.fn(async (_params: Parameters<GroundingVerificationDependencies["lookupContradictionCandidates"]>[0]) => []);
    const input = makeVerificationInput({
      source: { ...makeVerificationInput().source, circular: { ...makeVerificationInput().source.circular, date_effective: null as unknown as string } }
    });

    await verifyGrounding(input, baseDeps({ generateVerification, lookupContradictionCandidates }));

    const calledWith = lookupContradictionCandidates.mock.calls[0]?.[0];
    const today = new Date().toISOString().slice(0, 10);
    expect(calledWith?.as_of).toBe(today);
  });

  it("FR-3: confidence_score is never surfaced in the prompt sent to the model", async () => {
    let capturedPrompt = "";
    const generateVerification = vi.fn(async (prompt: string) => {
      capturedPrompt = prompt;
      return generateResult(cleanPassModelOutput());
    });

    await verifyGrounding(makeVerificationInput({ proposed: { ...makeVerificationInput().proposed, confidence_score: 0.42 } }), baseDeps({ generateVerification }));

    expect(capturedPrompt).not.toMatch(/0\.42/);
    expect(capturedPrompt).not.toMatch(/confidence/i);
  });

  it("does not throw on a hallucinated conflicting_obligation_id not present in the fetched candidate set", async () => {
    const candidate = makeCandidate({ obligation_id: "ob-real" });
    const generateVerification = vi.fn(async () => generateResult(contradictionModelOutput("ob-not-a-real-candidate")));

    const output = await verifyGrounding(
      makeVerificationInput(),
      baseDeps({ generateVerification, lookupContradictionCandidates: vi.fn(async () => [candidate]) })
    );

    expect(output.contradiction).toBe(false);
    expect(output.contradiction_details).toEqual([]);
  });
});
