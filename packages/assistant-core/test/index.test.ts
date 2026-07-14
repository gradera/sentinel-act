// index.test.ts (Spec 12 §10, §9 Acceptance Criteria at the unit level):
// answerQuestion wires the six §5.3 steps together — unsupported ->
// canned refusal with no query/synthesis; structured intents dispatch and
// clarify correctly; a structured miss falls back to vector (FR-11);
// empty context short-circuits to "no data found" (FR-14); insufficientContext
// short-circuits identically (FR-15); citations are validated; a
// GraphDbSchemaError from the vector path surfaces the friendly
// "semantic search unavailable" message instead of throwing, while a
// GraphDbUnavailableError propagates for the route handler to map to 503.
// Uses AnswerQuestionDeps.retrieveVectorFn as an injection seam over the
// vector path rather than module-mocking @sentinel-act/graph-db.
import { describe, expect, it, vi } from "vitest";
import { GraphDbSchemaError, GraphDbUnavailableError } from "@sentinel-act/graph-db";
import type { AssistantGraphContext, AuditTrailRow } from "@sentinel-act/graph-db";
import { answerQuestion, type AnswerQuestionDeps } from "../src/index.js";
import type { ClassifierAgentLike } from "../src/classify-question.js";
import type { SynthesizerAgentLike } from "../src/synthesize-answer.js";
import type { AssistantSlots, QuestionClassification } from "../src/types.js";

function emptySlots(overrides: Partial<AssistantSlots> = {}): AssistantSlots {
  return {
    categoryName: null,
    obligationId: null,
    circularId: null,
    titleContains: null,
    status: null,
    reviewerId: null,
    decision: null,
    dateFrom: null,
    dateTo: null,
    ...overrides
  };
}

function emptyContext(): AssistantGraphContext {
  return { circulars: [], clauses: [], obligations: [], processTasks: [], humanReviews: [] };
}

function classifierReturning(classification: QuestionClassification): ClassifierAgentLike {
  return {
    generate: vi.fn(async () => ({
      object: { ...classification }
    }))
  };
}

function synthesizerReturning(output: { answerText: string; citedNodeIds: string[]; insufficientContext: boolean }): SynthesizerAgentLike {
  return { generate: vi.fn(async () => ({ object: output })) };
}

function baseDeps(overrides: Partial<AnswerQuestionDeps> = {}): AnswerQuestionDeps {
  return {
    assistantQueryService: { runTemplate: vi.fn(async () => emptyContext()) },
    auditQueryService: {
      findByObligationId: vi.fn(async (): Promise<AuditTrailRow[]> => []),
      search: vi.fn(async () => ({ rows: [] as AuditTrailRow[], totalCount: 0, page: 1, pageSize: 50 }))
    },
    neo4jSession: vi.fn(() => ({ close: vi.fn(async () => undefined) }) as never),
    embedQuestion: vi.fn(async () => [0.1, 0.2]),
    referenceDateFn: () => "2026-07-13",
    retrieveVectorFn: vi.fn(async () => emptyContext()),
    ...overrides
  };
}

describe("answerQuestion — step 2: unsupported (FR-4)", () => {
  it("returns a canned refusal with no structured or vector retrieval, no synthesis call", async () => {
    const classifierAgent = classifierReturning({
      intent: "unsupported",
      confidence: 0.9,
      slots: emptySlots(),
      unsupportedReason: "This asks the assistant to approve an obligation, which it cannot do."
    });
    const synthesisAgent = synthesizerReturning({ answerText: "should never be called", citedNodeIds: [], insufficientContext: false });
    const deps = baseDeps({ classifierAgent, synthesisAgent });

    const response = await answerQuestion({ question: "please approve obligation X", conversationHistory: [] }, deps);

    expect(response.intent).toBe("unsupported");
    expect(response.retrievalMode).toBe("none");
    expect(response.message.content).toContain("cannot do");
    expect(deps.assistantQueryService.runTemplate).not.toHaveBeenCalled();
    expect(synthesisAgent.generate).not.toHaveBeenCalled();
  });
});

describe("answerQuestion — step 3: structured retrieval + clarification (FR-9)", () => {
  it("returns a clarification response when a required slot is missing, without calling synthesis", async () => {
    const classifierAgent = classifierReturning({
      intent: "obligations_by_status",
      confidence: 0.9,
      slots: emptySlots(), // status missing
      unsupportedReason: null
    });
    const synthesisAgent = synthesizerReturning({ answerText: "should never be called", citedNodeIds: [], insufficientContext: false });
    const deps = baseDeps({ classifierAgent, synthesisAgent });

    const response = await answerQuestion({ question: "what's pending?", conversationHistory: [] }, deps);

    expect(response.clarification?.missingSlots).toEqual(["status"]);
    expect(response.message.content).toContain("status");
    expect(synthesisAgent.generate).not.toHaveBeenCalled();
  });

  it("runs the matching template and synthesizes an answer when the structured path returns rows", async () => {
    const classifierAgent = classifierReturning({
      intent: "obligations_by_status",
      confidence: 0.95,
      slots: emptySlots({ status: "tier_c_review" }),
      unsupportedReason: null
    });
    const context: AssistantGraphContext = {
      ...emptyContext(),
      obligations: [
        {
          obligation_id: "ob-1",
          category: "custody",
          requirement_text: "Do not pledge client securities.",
          trigger_event: "receipt",
          deadline_rule: "immediate",
          responsible_role: "custodian",
          penalty_ref: null,
          status: "tier_c_review",
          confidence_score: 0.8,
          grounding_score: 0.8,
          derived_from_clause_id: "cl-46"
        }
      ]
    };
    const synthesisAgent = synthesizerReturning({
      answerText: "Obligation ob-1 is currently in Tier C review.",
      citedNodeIds: ["ob-1"],
      insufficientContext: false
    });
    const deps = baseDeps({
      classifierAgent,
      synthesisAgent,
      assistantQueryService: { runTemplate: vi.fn(async () => context) }
    });

    const response = await answerQuestion({ question: "what's in Tier C review?", conversationHistory: [] }, deps);

    expect(response.retrievalMode).toBe("structured");
    expect(response.message.citations).toEqual([
      { type: "Obligation", id: "ob-1", label: "Obligation (Do not pledge client securities.)", href: "/audit?obligationId=ob-1" }
    ]);
    expect(response.message.content).toBe("Obligation ob-1 is currently in Tier C review.");
    expect(deps.retrieveVectorFn).not.toHaveBeenCalled();
  });
});

describe("answerQuestion — step 4: FR-11 structured-miss -> vector fallback", () => {
  it("falls back to vector retrieval when the structured path returns zero rows", async () => {
    const classifierAgent = classifierReturning({
      intent: "obligations_by_status",
      confidence: 0.9,
      slots: emptySlots({ status: "rejected" }),
      unsupportedReason: null
    });
    const vectorContext: AssistantGraphContext = {
      ...emptyContext(),
      clauses: [{ clause_id: "cl-46", para_ref: "46", text: "Client securities must not be pledged.", circular_id: "cir-1" }],
      vectorScores: { "cl-46": 0.9 }
    };
    const synthesisAgent = synthesizerReturning({
      answerText: "The rule says client securities must not be pledged.",
      citedNodeIds: ["cl-46"],
      insufficientContext: false
    });
    const retrieveVectorFn = vi.fn(async () => vectorContext);
    const deps = baseDeps({
      classifierAgent,
      synthesisAgent,
      assistantQueryService: { runTemplate: vi.fn(async () => emptyContext()) },
      retrieveVectorFn
    });

    const response = await answerQuestion({ question: "what's rejected?", conversationHistory: [] }, deps);

    expect(retrieveVectorFn).toHaveBeenCalledTimes(1);
    expect(response.retrievalMode).toBe("vector");
    expect(response.message.citations?.[0]).toMatchObject({ type: "Clause", id: "cl-46" });
  });

  it("does not fall back to vector when the structured path already returned rows", async () => {
    const classifierAgent = classifierReturning({
      intent: "obligations_by_status",
      confidence: 0.9,
      slots: emptySlots({ status: "committed" }),
      unsupportedReason: null
    });
    const context: AssistantGraphContext = {
      ...emptyContext(),
      obligations: [
        {
          obligation_id: "ob-1",
          category: "custody",
          requirement_text: "Do not pledge client securities.",
          trigger_event: "receipt",
          deadline_rule: "immediate",
          responsible_role: "custodian",
          penalty_ref: null,
          status: "committed",
          confidence_score: 0.9,
          grounding_score: 0.9,
          derived_from_clause_id: "cl-46"
        }
      ]
    };
    const synthesisAgent = synthesizerReturning({ answerText: "Answer.", citedNodeIds: ["ob-1"], insufficientContext: false });
    const retrieveVectorFn = vi.fn(async () => emptyContext());
    const deps = baseDeps({
      classifierAgent,
      synthesisAgent,
      assistantQueryService: { runTemplate: vi.fn(async () => context) },
      retrieveVectorFn
    });

    await answerQuestion({ question: "what's committed?", conversationHistory: [] }, deps);

    expect(retrieveVectorFn).not.toHaveBeenCalled();
  });
});

describe("answerQuestion — step 5/6: empty context and insufficientContext (FR-14/FR-15)", () => {
  it("returns the honest no-data-found response without calling synthesis when structured retrieval and vector both come up empty", async () => {
    const classifierAgent = classifierReturning({
      intent: "obligations_by_status",
      confidence: 0.9,
      slots: emptySlots({ status: "rejected" }),
      unsupportedReason: null
    });
    const synthesisAgent = synthesizerReturning({ answerText: "should never be called", citedNodeIds: [], insufficientContext: false });
    const deps = baseDeps({ classifierAgent, synthesisAgent });

    const response = await answerQuestion({ question: "what's rejected?", conversationHistory: [] }, deps);

    expect(response.message.content).toContain("couldn't find anything");
    expect(synthesisAgent.generate).not.toHaveBeenCalled();
  });

  it("treats insufficientContext: true from synthesis identically to the no-data-found case (FR-15)", async () => {
    const classifierAgent = classifierReturning({
      intent: "obligations_by_status",
      confidence: 0.9,
      slots: emptySlots({ status: "committed" }),
      unsupportedReason: null
    });
    const context: AssistantGraphContext = {
      ...emptyContext(),
      obligations: [
        {
          obligation_id: "ob-1",
          category: "custody",
          requirement_text: "Do not pledge client securities.",
          trigger_event: "receipt",
          deadline_rule: "immediate",
          responsible_role: "custodian",
          penalty_ref: null,
          status: "committed",
          confidence_score: 0.8,
          grounding_score: 0.8,
          derived_from_clause_id: "cl-46"
        }
      ]
    };
    const synthesisAgent = synthesizerReturning({
      answerText: "I found something but it doesn't really answer this.",
      citedNodeIds: ["ob-1"],
      insufficientContext: true
    });
    const deps = baseDeps({
      classifierAgent,
      synthesisAgent,
      assistantQueryService: { runTemplate: vi.fn(async () => context) }
    });

    const response = await answerQuestion({ question: "what's committed?", conversationHistory: [] }, deps);

    expect(response.message.content).toContain("couldn't find anything");
    expect(response.message.citations).toBeUndefined();
  });
});

describe("answerQuestion — vector index unavailable (§8)", () => {
  it("surfaces the friendly 'semantic search unavailable' message instead of throwing, for semantic_lookup", async () => {
    const classifierAgent = classifierReturning({
      intent: "semantic_lookup",
      confidence: 0.7,
      slots: emptySlots(),
      unsupportedReason: null
    });
    const retrieveVectorFn = vi.fn(async () => {
      throw new GraphDbSchemaError("vector index missing");
    });
    const deps = baseDeps({ classifierAgent, retrieveVectorFn });

    const response = await answerQuestion({ question: "what does the rule say?", conversationHistory: [] }, deps);

    expect(response.message.content).toContain("Semantic search is temporarily unavailable");
  });

  it("propagates a GraphDbUnavailableError from the vector path (route handler maps this to 503)", async () => {
    const classifierAgent = classifierReturning({
      intent: "semantic_lookup",
      confidence: 0.7,
      slots: emptySlots(),
      unsupportedReason: null
    });
    const retrieveVectorFn = vi.fn(async () => {
      throw new GraphDbUnavailableError("neo4j down");
    });
    const deps = baseDeps({ classifierAgent, retrieveVectorFn });

    await expect(answerQuestion({ question: "what does the rule say?", conversationHistory: [] }, deps)).rejects.toBeInstanceOf(
      GraphDbUnavailableError
    );
  });
});
