// synthesize-answer.test.ts (Spec 12 §10): schema-valid output passed
// through unchanged; retry-on-schema-failure behavior mirrors the
// classifier's (one retry with the validation error appended, then a
// template-only fallback rather than an error); a transport/provider
// error retries once too but throws AssistantProviderError on a second
// failure (§8).
import { describe, expect, it, vi } from "vitest";
import type { AssistantGraphContext } from "@sentinel-act/graph-db";
import {
  buildTemplateOnlyFallback,
  synthesizeAnswer,
  type SynthesisInput,
  type SynthesizerAgentLike,
  type SynthesizerGenerateResult
} from "../src/synthesize-answer.js";
import { AssistantProviderError } from "../src/errors.js";
import type { ChatMessage } from "../src/types.js";

function emptyContext(): AssistantGraphContext {
  return { circulars: [], clauses: [], obligations: [], processTasks: [], humanReviews: [] };
}

function baseInput(overrides: Partial<SynthesisInput> = {}): SynthesisInput {
  return {
    question: "Who approved the CUSPA change and why?",
    conversationHistory: [],
    retrievedContext: emptyContext(),
    retrievalMode: "structured",
    referenceDate: "2026-07-13",
    ...overrides
  };
}

function validSynthesisOutput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    answerText: "Reviewer reviewer-1 approved this on 2026-02-05, citing consistency with existing custody obligations.",
    citedNodeIds: ["rev-1", "ob-1"],
    insufficientContext: false,
    ...overrides
  };
}

function buildAgent(generate: (prompt: string) => Promise<SynthesizerGenerateResult>): SynthesizerAgentLike {
  return { generate: vi.fn(generate) };
}

function chatMessage(content: string, role: "user" | "assistant" = "user"): ChatMessage {
  return { role, content, createdAt: "2026-07-01T00:00:00Z" };
}

describe("synthesizeAnswer", () => {
  it("passes a schema-valid output through unchanged", async () => {
    const agent = buildAgent(async () => ({ object: validSynthesisOutput() }));

    const result = await synthesizeAnswer(baseInput(), agent);

    expect(result.answerText).toContain("reviewer-1");
    expect(result.citedNodeIds).toEqual(["rev-1", "ob-1"]);
    expect(result.insufficientContext).toBe(false);
    expect(agent.generate).toHaveBeenCalledTimes(1);
  });

  it("retries exactly once with the validation error appended when the first response is schema-invalid", async () => {
    const prompts: string[] = [];
    let callCount = 0;
    const agent = buildAgent(async (prompt: string) => {
      prompts.push(prompt);
      callCount += 1;
      if (callCount === 1) {
        return { object: { answerText: "", citedNodeIds: "not-an-array", insufficientContext: "not-a-bool" } };
      }
      return { object: validSynthesisOutput() };
    });

    const result = await synthesizeAnswer(baseInput(), agent);

    expect(callCount).toBe(2);
    expect(prompts[1]).toContain("Your previous output failed validation");
    expect(result.citedNodeIds).toEqual(["rev-1", "ob-1"]);
  });

  it("falls back to buildTemplateOnlyFallback when schema validation fails twice (§8)", async () => {
    const agent = buildAgent(async () => ({
      object: { answerText: "", citedNodeIds: "nope", insufficientContext: "nope" }
    }));
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

    const result = await synthesizeAnswer(baseInput({ retrievedContext: context }), agent);

    expect(result).toEqual(buildTemplateOnlyFallback(context));
    expect(result.citedNodeIds).toContain("ob-1");
    expect(result.insufficientContext).toBe(false);
  });

  it("retries once on a transport/provider error, and succeeds if the retry works", async () => {
    let callCount = 0;
    const agent = buildAgent(async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("network blip");
      }
      return { object: validSynthesisOutput() };
    });

    const result = await synthesizeAnswer(baseInput(), agent);

    expect(callCount).toBe(2);
    expect(result.citedNodeIds).toEqual(["rev-1", "ob-1"]);
  });

  it("throws AssistantProviderError('synthesize') when the transport error persists across both attempts", async () => {
    const agent = buildAgent(async () => {
      throw new Error("provider down");
    });

    const error = await synthesizeAnswer(baseInput(), agent).catch((e) => e);
    expect(error).toBeInstanceOf(AssistantProviderError);
    expect((error as AssistantProviderError).call).toBe("synthesize");
  });

  it("passes insufficientContext: true through unchanged (the caller, index.ts, treats it as a no-answer case)", async () => {
    const agent = buildAgent(async () => ({
      object: validSynthesisOutput({ insufficientContext: true, answerText: "The retrieved facts don't cover this." })
    }));

    const result = await synthesizeAnswer(baseInput(), agent);

    expect(result.insufficientContext).toBe(true);
  });

  it("truncates conversationHistory to the trailing 6 messages before it reaches the prompt", async () => {
    const history: ChatMessage[] = Array.from({ length: 9 }, (_, i) => chatMessage(`turn-${i}`));
    let capturedPrompt = "";
    const agent = buildAgent(async (prompt: string) => {
      capturedPrompt = prompt;
      return { object: validSynthesisOutput() };
    });

    await synthesizeAnswer(baseInput({ conversationHistory: history }), agent);

    expect(capturedPrompt).not.toContain("turn-0");
    expect(capturedPrompt).not.toContain("turn-2");
    expect(capturedPrompt).toContain("turn-3");
    expect(capturedPrompt).toContain("turn-8");
  });

  it("includes the sanitized, delimited retrieved context in the prompt", async () => {
    let capturedPrompt = "";
    const agent = buildAgent(async (prompt: string) => {
      capturedPrompt = prompt;
      return { object: validSynthesisOutput() };
    });
    const context: AssistantGraphContext = {
      ...emptyContext(),
      clauses: [{ clause_id: "cl-46", para_ref: "46", text: "Client securities must not be pledged.", circular_id: "cir-1" }]
    };

    await synthesizeAnswer(baseInput({ retrievedContext: context }), agent);

    expect(capturedPrompt).toContain('<<<UNTRUSTED_DATA type="Clause" id="cl-46" field="text">>>');
    expect(capturedPrompt).toContain("Client securities must not be pledged.");
  });
});

describe("buildTemplateOnlyFallback", () => {
  it("lists every retrieved node and cites all of their ids", () => {
    const context: AssistantGraphContext = {
      circulars: [{ circular_id: "cir-1", title: "CUSPA Master Circular", date_issued: "2026-01-01", date_effective: "2026-02-01" }],
      clauses: [{ clause_id: "cl-46", para_ref: "46", text: "Client securities must not be pledged.", circular_id: "cir-1" }],
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
      ],
      processTasks: [
        { task_id: "task-1", task_name: "Reconcile ledger", owner_role: "custodian-ops", sla_hours: 24, risk_score: 0.4, obligation_id: "ob-1" }
      ],
      humanReviews: [
        {
          review_id: "rev-1",
          reviewer_id: "reviewer-1",
          tier: "B",
          decision: "approve",
          rationale: "Consistent with existing custody obligations.",
          decided_at: "2026-02-05T00:00:00Z",
          obligation_id: "ob-1"
        }
      ]
    };

    const result = buildTemplateOnlyFallback(context);

    expect(result.citedNodeIds).toEqual(["cir-1", "cl-46", "ob-1", "task-1", "rev-1"]);
    expect(result.answerText).toContain("CUSPA Master Circular");
    expect(result.answerText).toContain("Consistent with existing custody obligations.");
    expect(result.insufficientContext).toBe(false);
  });

  it("returns a generic message with no citations for an empty context", () => {
    const result = buildTemplateOnlyFallback(emptyContext());
    expect(result.citedNodeIds).toEqual([]);
    expect(result.answerText.length).toBeGreaterThan(0);
  });

  it("never exceeds the 2000-character answerText cap", () => {
    const manyObligations: AssistantGraphContext["obligations"] = Array.from({ length: 50 }, (_, i) => ({
      obligation_id: `ob-${i}`,
      category: "custody",
      requirement_text: "Do not pledge client securities. ".repeat(5),
      trigger_event: "receipt",
      deadline_rule: "immediate",
      responsible_role: "custodian",
      penalty_ref: null,
      status: "committed",
      confidence_score: 0.9,
      grounding_score: 0.9,
      derived_from_clause_id: "cl-46"
    }));

    const result = buildTemplateOnlyFallback({ ...emptyContext(), obligations: manyObligations });

    expect(result.answerText.length).toBeLessThanOrEqual(2000);
  });
});
