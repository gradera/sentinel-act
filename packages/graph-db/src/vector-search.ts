// GraphRAG semantic clause retrieval (§5.6, FR-20). MUST call
// db.index.vector.queryNodes against clause_embedding_index and MUST NOT
// fall back to a brute-force application-side cosine scan — if the index
// is missing or misconfigured, this throws GraphDbSchemaError rather than
// silently degrading (a hackathon demo must not look fast because it
// quietly did an O(n) scan on a small dataset).
import neo4j, { type Session } from "neo4j-driver";
import type { VectorSearchQuery, VectorSearchResult } from "./types.js";
import { GraphDbSchemaError } from "./errors.js";
import { logOperation } from "./logger.js";
import { pointInTimeWhereClause } from "./point-in-time.js";
import { deserializeClauseNode } from "./repositories/clause.repository.js";

const VECTOR_INDEX_NAME = "clause_embedding_index";
/** NFR-6: topK is capped server-side at 50 regardless of what a caller
 *  requests, to bound Aura compute cost during the demo. */
const MAX_TOP_K = 50;
const DEFAULT_TOP_K = 5;

function isMissingIndexError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("index") &&
    (message.includes("no such") ||
      message.includes("not found") ||
      message.includes("does not exist") ||
      message.includes("unable to find"))
  );
}

export async function findSimilarClauses(session: Session, query: VectorSearchQuery): Promise<VectorSearchResult[]> {
  const start = Date.now();
  const requestedTopK = query.topK ?? DEFAULT_TOP_K;
  const cappedTopK = Math.min(Math.max(requestedTopK, 1), MAX_TOP_K);

  const params: Record<string, unknown> = {
    indexName: VECTOR_INDEX_NAME,
    topK: neo4j.int(cappedTopK),
    queryEmbedding: query.queryEmbedding
  };
  const whereClause = query.asOfDate ? `WHERE ${pointInTimeWhereClause("node", "asOfDate")}` : "";
  if (query.asOfDate) {
    params.asOfDate = query.asOfDate;
  }

  const cypher = `
    CALL db.index.vector.queryNodes($indexName, $topK, $queryEmbedding)
    YIELD node, score
    ${whereClause}
    RETURN node, score
    ORDER BY score DESC
  `;

  try {
    const result = await session.executeRead((tx) => tx.run(cypher, params));
    const values = result.records.map((record) => ({
      clause: deserializeClauseNode(record.get("node").properties as Record<string, unknown>),
      score: record.get("score") as number
    }));
    logOperation({
      operation: "findSimilarClauses",
      label: "Clause",
      durationMs: Date.now() - start,
      outcome: "success"
    });
    return values;
  } catch (error) {
    logOperation({
      operation: "findSimilarClauses",
      label: "Clause",
      durationMs: Date.now() - start,
      outcome: "error"
    });
    if (isMissingIndexError(error)) {
      throw new GraphDbSchemaError(
        `Vector index "${VECTOR_INDEX_NAME}" is missing or misconfigured — run "pnpm --filter @sentinel-act/graph-db migrate" before calling findSimilarClauses.`,
        { cause: error }
      );
    }
    throw error;
  }
}
