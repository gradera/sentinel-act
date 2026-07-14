// Spec 12 §10 API route tests — POST /api/assistant/query. Mirrors
// app/api/audit/reviews/route.test.ts's pattern: vi.mock the service-layer
// modules (here, @sentinel-act/assistant-core's answerQuestion — the ONE
// function this route calls — and @sentinel-act/graph-db's driver/service
// constructors, so no real Neo4j/LLM call ever happens in this test file)
// before importing the route handler, construct a NextRequest directly,
// call the handler, assert on status/body.
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { answerQuestionMock } = vi.hoisted(() => ({ answerQuestionMock: vi.fn() }));

vi.mock("@sentinel-act/assistant-core", async () => {
  const actual = await vi.importActual<typeof import("@sentinel-act/assistant-core")>("@sentinel-act/assistant-core");
  return { ...actual, answerQuestion: answerQuestionMock };
});

vi.mock("@sentinel-act/graph-db", async () => {
  const actual = await vi.importActual<typeof import("@sentinel-act/graph-db")>("@sentinel-act/graph-db");
  return {
    ...actual,
    getAssistantReadOnlyDriver: vi.fn(() => ({ session: vi.fn(() => ({ close: vi.fn() })) })),
    getAssistantSingletonDatabase: vi.fn(() => "neo4j"),
    AssistantQueryService: vi.fn().mockImplementation(() => ({})),
    AuditQueryService: vi.fn().mockImplementation(() => ({}))
  };
});

vi.mock("@/lib/console/assistant-embed", () => ({ embedQuestion: vi.fn(async () => new Array(1536).fill(0)) }));

import { POST } from "./route";
import { resetAssistantRateLimitsForTest } from "@/lib/console/assistant-rate-limit";

const REVIEWER_HEADERS = { "x-dev-reviewer-id": "reviewer-1", "x-dev-reviewer-role": "compliance_officer" };
const AUDITOR_HEADERS = { "x-dev-reviewer-id": "auditor-1", "x-dev-reviewer-role": "compliance_head" };

function makeRequest(body: unknown, headers: Record<string, string> = REVIEWER_HEADERS): NextRequest {
  return new NextRequest("http://localhost/api/assistant/query", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

const SUCCESS_RESPONSE = {
  message: { role: "assistant", content: "Answer.", createdAt: "2026-07-13T00:00:00.000Z" },
  intent: "semantic_lookup",
  retrievalMode: "vector"
};

beforeEach(() => {
  resetAssistantRateLimitsForTest();
  answerQuestionMock.mockReset();
  answerQuestionMock.mockResolvedValue(SUCCESS_RESPONSE);
});

describe("POST /api/assistant/query", () => {
  it("401 when no session is present", async () => {
    const response = await POST(makeRequest({ question: "What is CUSPA?" }, {}));
    expect(response.status).toBe(401);
    expect(answerQuestionMock).not.toHaveBeenCalled();
  });

  // NFR-9: every real ReviewerRole is allowed (assistant is not scoped to
  // one persona) — both an Operator-mode role and the Observer-mode role
  // succeed.
  it("200 for a compliance_officer (Operator-mode role)", async () => {
    const response = await POST(makeRequest({ question: "What is CUSPA?" }, REVIEWER_HEADERS));
    expect(response.status).toBe(200);
  });

  it("200 for a compliance_head (Observer-mode role)", async () => {
    const response = await POST(makeRequest({ question: "What is CUSPA?" }, AUDITOR_HEADERS));
    expect(response.status).toBe(200);
  });

  it("400 for an empty question, before answerQuestion is called", async () => {
    const response = await POST(makeRequest({ question: "" }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.field).toBe("question");
    expect(answerQuestionMock).not.toHaveBeenCalled();
  });

  it("400 for a missing question field", async () => {
    const response = await POST(makeRequest({}));
    expect(response.status).toBe(400);
    expect(answerQuestionMock).not.toHaveBeenCalled();
  });

  it("200 with the answerQuestion response echoed back verbatim", async () => {
    const response = await POST(makeRequest({ question: "What is CUSPA?" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(SUCCESS_RESPONSE);
  });

  // §7 NFR-5: conversationHistory > 6 turns is truncated to the trailing 6
  // BEFORE answerQuestion is invoked.
  it("truncates conversationHistory to the trailing 6 turns before calling answerQuestion", async () => {
    const history = Array.from({ length: 9 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `turn ${i}`,
      createdAt: "2026-07-13T00:00:00.000Z"
    }));
    await POST(makeRequest({ question: "Follow-up question", conversationHistory: history }));

    expect(answerQuestionMock).toHaveBeenCalledTimes(1);
    const [passedRequest] = answerQuestionMock.mock.calls[0];
    expect(passedRequest.conversationHistory).toHaveLength(6);
    expect(passedRequest.conversationHistory[0].content).toBe("turn 3");
    expect(passedRequest.conversationHistory[5].content).toBe("turn 8");
  });

  it("defaults conversationHistory to [] when omitted", async () => {
    await POST(makeRequest({ question: "What is CUSPA?" }));
    const [passedRequest] = answerQuestionMock.mock.calls[0];
    expect(passedRequest.conversationHistory).toEqual([]);
  });

  // §7 NFR-5: 20 requests/minute default, keyed by reviewerId.
  it("429 after exceeding the per-minute rate limit for one reviewer", async () => {
    for (let i = 0; i < 20; i++) {
      const response = await POST(makeRequest({ question: `Question ${i}` }));
      expect(response.status).toBe(200);
    }
    const response = await POST(makeRequest({ question: "One too many" }));
    expect(response.status).toBe(429);
  });

  it("does not rate-limit a different reviewer independently of another's usage", async () => {
    for (let i = 0; i < 20; i++) {
      await POST(makeRequest({ question: `Question ${i}` }, REVIEWER_HEADERS));
    }
    const response = await POST(makeRequest({ question: "Fresh reviewer" }, AUDITOR_HEADERS));
    expect(response.status).toBe(200);
  });

  it("503 when answerQuestion throws AssistantProviderError", async () => {
    const { AssistantProviderError } = await vi.importActual<typeof import("@sentinel-act/assistant-core")>("@sentinel-act/assistant-core");
    answerQuestionMock.mockRejectedValueOnce(new AssistantProviderError("classify"));
    const response = await POST(makeRequest({ question: "What is CUSPA?" }));
    expect(response.status).toBe(503);
  });

  it("503 when answerQuestion throws GraphDbUnavailableError", async () => {
    const { GraphDbUnavailableError } = await vi.importActual<typeof import("@sentinel-act/graph-db")>("@sentinel-act/graph-db");
    answerQuestionMock.mockRejectedValueOnce(new GraphDbUnavailableError("down"));
    const response = await POST(makeRequest({ question: "What is CUSPA?" }));
    expect(response.status).toBe(503);
  });

  it("500 for an unrecognized error", async () => {
    answerQuestionMock.mockRejectedValueOnce(new Error("boom"));
    const response = await POST(makeRequest({ question: "What is CUSPA?" }));
    expect(response.status).toBe(500);
  });
});
