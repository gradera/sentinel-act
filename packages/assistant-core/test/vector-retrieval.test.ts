// vector-retrieval.test.ts (Spec 12 §10): calls findSimilarClauses with
// topK: 5 regardless of any caller-requested value; builds an
// AssistantGraphContext whose clauses + vectorScores reflect the results;
// always closes the session it opened, even when the query throws.
import { describe, expect, it, vi } from "vitest";

const findSimilarClauses = vi.fn();

vi.mock("@sentinel-act/graph-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sentinel-act/graph-db")>();
  return { ...actual, findSimilarClauses };
});

const { retrieveVector, VECTOR_RETRIEVAL_TOP_K } = await import("../src/vector-retrieval.js");

function clause(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    clause_id: "cl-46",
    para_ref: "46",
    text: "Client securities must not be pledged.",
    circular_id: "cir-1",
    embedding_ref: "[0.1,0.2]",
    valid_from: "2026-01-01",
    valid_to: null,
    recorded_at: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

describe("retrieveVector", () => {
  it("always calls findSimilarClauses with topK: 5, regardless of anything else", async () => {
    findSimilarClauses.mockResolvedValueOnce([]);
    const session = { close: vi.fn(async () => undefined) };
    const deps = { neo4jSession: () => session, embedQuestion: vi.fn(async () => [0.1, 0.2, 0.3]) };

    await retrieveVector("what does the rule about pledging say?", deps as never);

    expect(VECTOR_RETRIEVAL_TOP_K).toBe(5);
    expect(findSimilarClauses).toHaveBeenCalledWith(session, {
      queryEmbedding: [0.1, 0.2, 0.3],
      topK: 5,
      asOfDate: undefined
    });
  });

  it("builds clauses + vectorScores from the results", async () => {
    findSimilarClauses.mockResolvedValueOnce([
      { clause: clause(), score: 0.87 },
      { clause: clause({ clause_id: "cl-47", para_ref: "47" }), score: 0.71 }
    ]);
    const session = { close: vi.fn(async () => undefined) };
    const deps = { neo4jSession: () => session, embedQuestion: vi.fn(async () => [0.1]) };

    const context = await retrieveVector("what does the rule say?", deps as never);

    expect(context.clauses).toHaveLength(2);
    expect(context.clauses[0]).toMatchObject({ clause_id: "cl-46", para_ref: "46", circular_id: "cir-1" });
    expect(context.vectorScores).toEqual({ "cl-46": 0.87, "cl-47": 0.71 });
    expect(context.obligations).toHaveLength(0);
    expect(context.circulars).toHaveLength(0);
  });

  it("passes asOfDate through when provided", async () => {
    findSimilarClauses.mockResolvedValueOnce([]);
    const session = { close: vi.fn(async () => undefined) };
    const deps = { neo4jSession: () => session, embedQuestion: vi.fn(async () => [0.1]) };

    await retrieveVector("question", deps as never, "2026-07-01");

    expect(findSimilarClauses).toHaveBeenCalledWith(session, {
      queryEmbedding: [0.1],
      topK: 5,
      asOfDate: "2026-07-01"
    });
  });

  it("always closes the session, even when findSimilarClauses throws", async () => {
    findSimilarClauses.mockRejectedValueOnce(new Error("vector index missing"));
    const closeSpy = vi.fn(async () => undefined);
    const session = { close: closeSpy };
    const deps = { neo4jSession: () => session, embedQuestion: vi.fn(async () => [0.1]) };

    await expect(retrieveVector("question", deps as never)).rejects.toThrow("vector index missing");
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
