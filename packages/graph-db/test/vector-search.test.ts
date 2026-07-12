// vector-search.test.ts (spec §10): findSimilarClauses calls
// db.index.vector.queryNodes with the configured index name, and caps
// topK at 50 even if a caller requests more (FR-20, NFR-6).
import { describe, expect, it } from "vitest";
import neo4j, { type Session } from "neo4j-driver";
import { vi } from "vitest";
import { findSimilarClauses } from "../src/vector-search.js";
import { GraphDbSchemaError } from "../src/errors.js";
import { mockRecord } from "./helpers/mock-driver.js";

function clauseNodeProperties() {
  return {
    clause_id: "cl-1",
    circular_id: "cir-1",
    para_ref: "46",
    text: "some clause text",
    embedding_ref: [0.1, 0.2, 0.3],
    valid_from: "2026-01-01",
    valid_to: null,
    recorded_at: "2026-01-01T00:00:00Z"
  };
}

function buildSession(handler: (cypher: string, params: Record<string, unknown>) => { records: ReturnType<typeof mockRecord>[] }): Session {
  return {
    executeRead: vi.fn(async (work: (tx: unknown) => unknown) => {
      const tx = {
        run: vi.fn(async (cypher: string, params: Record<string, unknown>) => handler(cypher, params))
      };
      return work(tx);
    })
  } as unknown as Session;
}

describe("findSimilarClauses", () => {
  it("calls db.index.vector.queryNodes with the configured index name", async () => {
    let capturedCypher = "";
    let capturedParams: Record<string, unknown> = {};
    const session = buildSession((cypher, params) => {
      capturedCypher = cypher;
      capturedParams = params;
      return { records: [mockRecord({ node: { properties: clauseNodeProperties() }, score: 0.87 })] };
    });

    const results = await findSimilarClauses(session, { queryEmbedding: [0.1, 0.2, 0.3], topK: 3 });

    expect(capturedCypher).toContain("CALL db.index.vector.queryNodes($indexName, $topK, $queryEmbedding)");
    expect(capturedParams.indexName).toBe("clause_embedding_index");
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(0.87);
    expect(results[0].clause.clause_id).toBe("cl-1");
  });

  it("caps topK at 50 even if the caller requests more", async () => {
    let capturedParams: Record<string, unknown> = {};
    const session = buildSession((_cypher, params) => {
      capturedParams = params;
      return { records: [] };
    });

    await findSimilarClauses(session, { queryEmbedding: [0.1], topK: 500 });

    const topK = capturedParams.topK as ReturnType<typeof neo4j.int>;
    expect(neo4j.isInt(topK) ? topK.toNumber() : topK).toBe(50);
  });

  it("throws GraphDbSchemaError when the vector index is missing", async () => {
    const session = buildSession(() => {
      throw new Error("There is no such vector schema index: clause_embedding_index");
    });

    await expect(findSimilarClauses(session, { queryEmbedding: [0.1], topK: 5 })).rejects.toBeInstanceOf(
      GraphDbSchemaError
    );
  });
});
