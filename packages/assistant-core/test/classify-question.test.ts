// classify-question.test.ts (Spec 12 §10): schema-valid classifier output
// is passed through unchanged; a schema-invalid first response triggers
// exactly one retry with the validation error appended; a second failure
// falls back to semantic_lookup/confidence 0 (FR-3); a transport/provider
// error retries once too but throws AssistantProviderError on a second
// failure (§8); low self-reported confidence routes to semantic_lookup
// unless the intent is already "unsupported"; conversationHistory is
// truncated to the trailing 6 messages before being sent to the model.
import { describe, expect, it, vi } from "vitest";
import {
  classifyQuestion,
  fallbackClassification,
  truncateConversationHistory,
  type ClassifierAgentLike,
  type ClassifierGenerateResult
} from "../src/classify-question.js";
import { AssistantProviderError } from "../src/errors.js";
import type { ChatMessage } from "../src/types.js";

function validClassifierOutput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    intent: "obligations_by_status",
    confidence: 0.92,
    slots: {
      categoryName: null,
      obligationId: null,
      circularId: null,
      titleContains: null,
      status: "tier_c_review",
      reviewerId: null,
      decision: null,
      dateFrom: null,
      dateTo: null
    },
    unsupportedReason: null,
    ...overrides
  };
}

function buildAgent(generate: (prompt: string) => Promise<ClassifierGenerateResult>): ClassifierAgentLike {
  return { generate: vi.fn(generate) };
}

function chatMessage(content: string, role: "user" | "assistant" = "user"): ChatMessage {
  return { role, content, createdAt: "2026-07-01T00:00:00Z" };
}

describe("classifyQuestion", () => {
  it("passes a schema-valid, high-confidence output through unchanged", async () => {
    const agent = buildAgent(async () => ({ object: validClassifierOutput() }));

    const result = await classifyQuestion("What's in Tier C review?", [], "2026-07-13", agent);

    expect(result.intent).toBe("obligations_by_status");
    expect(result.confidence).toBe(0.92);
    expect(result.slots.status).toBe("tier_c_review");
    expect(agent.generate).toHaveBeenCalledTimes(1);
  });

  it("retries exactly once with the validation error appended when the first response is schema-invalid", async () => {
    const prompts: string[] = [];
    let callCount = 0;
    const agent = buildAgent(async (prompt: string) => {
      prompts.push(prompt);
      callCount += 1;
      if (callCount === 1) {
        return { object: { intent: "not_a_real_intent", confidence: 2, slots: {}, unsupportedReason: null } };
      }
      return { object: validClassifierOutput() };
    });

    const result = await classifyQuestion("What's in Tier C review?", [], "2026-07-13", agent);

    expect(callCount).toBe(2);
    expect(prompts[1]).toContain("Your previous output failed validation");
    expect(result.intent).toBe("obligations_by_status");
  });

  it("falls back to semantic_lookup/confidence 0 when schema validation fails twice", async () => {
    const agent = buildAgent(async () => ({
      object: { intent: "not_a_real_intent", confidence: 2, slots: {}, unsupportedReason: null }
    }));

    const result = await classifyQuestion("garbled question", [], "2026-07-13", agent);

    expect(result).toEqual(fallbackClassification());
  });

  it("retries once on a transport/provider error, and succeeds if the retry works", async () => {
    let callCount = 0;
    const agent = buildAgent(async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("network blip");
      }
      return { object: validClassifierOutput() };
    });

    const result = await classifyQuestion("What's in Tier C review?", [], "2026-07-13", agent);

    expect(callCount).toBe(2);
    expect(result.intent).toBe("obligations_by_status");
  });

  it("throws AssistantProviderError('classify') when the transport error persists across both attempts", async () => {
    const agent = buildAgent(async () => {
      throw new Error("provider down");
    });

    const error = await classifyQuestion("What's in Tier C review?", [], "2026-07-13", agent).catch((e) => e);
    expect(error).toBeInstanceOf(AssistantProviderError);
    expect((error as AssistantProviderError).call).toBe("classify");
  });

  it("routes a low-confidence, non-unsupported classification to semantic_lookup (§8 ambiguous classification)", async () => {
    const agent = buildAgent(async () => ({
      object: validClassifierOutput({ confidence: 0.2 })
    }));

    const result = await classifyQuestion("something ambiguous", [], "2026-07-13", agent);

    expect(result).toEqual(fallbackClassification());
  });

  it("does NOT downgrade a low-confidence 'unsupported' classification (FR-4 holds regardless of confidence)", async () => {
    const agent = buildAgent(async () => ({
      object: validClassifierOutput({
        intent: "unsupported",
        confidence: 0.1,
        unsupportedReason: "This asks the assistant to approve an obligation, which it cannot do.",
        slots: {
          categoryName: null,
          obligationId: null,
          circularId: null,
          titleContains: null,
          status: null,
          reviewerId: null,
          decision: null,
          dateFrom: null,
          dateTo: null
        }
      })
    }));

    const result = await classifyQuestion("please approve obligation X", [], "2026-07-13", agent);

    expect(result.intent).toBe("unsupported");
    expect(result.unsupportedReason).toContain("cannot do");
  });

  it("truncates conversationHistory to the trailing 6 messages before it reaches the prompt", async () => {
    const history: ChatMessage[] = Array.from({ length: 9 }, (_, i) => chatMessage(`turn-${i}`));
    let capturedPrompt = "";
    const agent = buildAgent(async (prompt: string) => {
      capturedPrompt = prompt;
      return { object: validClassifierOutput() };
    });

    await classifyQuestion("a question", history, "2026-07-13", agent);

    expect(capturedPrompt).not.toContain("turn-0");
    expect(capturedPrompt).not.toContain("turn-2");
    expect(capturedPrompt).toContain("turn-3");
    expect(capturedPrompt).toContain("turn-8");
  });
});

describe("truncateConversationHistory", () => {
  it("keeps history unchanged when at or under the 6-turn cap", () => {
    const history = Array.from({ length: 6 }, (_, i) => chatMessage(`t${i}`));
    expect(truncateConversationHistory(history)).toHaveLength(6);
  });

  it("keeps only the trailing 6 turns when history exceeds the cap", () => {
    const history = Array.from({ length: 10 }, (_, i) => chatMessage(`t${i}`));
    const truncated = truncateConversationHistory(history);
    expect(truncated).toHaveLength(6);
    expect(truncated[0].content).toBe("t4");
    expect(truncated[5].content).toBe("t9");
  });
});
