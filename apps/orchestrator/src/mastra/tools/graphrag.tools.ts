// Read-only GraphRAG tools for the Obligation Extraction Agent (Spec 03
// §5.5, §4.4). Every query here opens a session via `driver.session(...)`
// and calls ONLY `session.executeRead(...)` — never `executeWrite`, and
// this file never emits a write-Cypher keyword (CREATE, MERGE, SET, DELETE) (FR-12,
// grep-verifiable). A prompt-injection attempt embedded in clause text
// cannot induce a graph write through these tools even if the model tries
// to call them with attacker-influenced arguments, because the
// driver/session layer itself has no write capability wired in here.
//
// FR-2 note: in normal operation these are NOT invoked via the model's
// own tool-calling discretion — `extractObligations()` in
// obligation-extraction.agent.ts always runs the three retrieval
// functions below up front, unconditionally, before the LLM call, so
// retrieval is deterministic and testable independent of model behavior.
// The Mastra `Tool` wrappers exported at the bottom exist so the Agent
// definition can still list them (per spec §5.1), e.g. for a follow-up
// clarification call, but the primary code path calls the plain async
// functions directly.
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getDriver, getSingletonDatabase } from "@sentinel-act/graph-db";
import { findSimilarClauses as graphDbFindSimilarClauses } from "@sentinel-act/graph-db";

// Reuse the exact Driver/Session types graph-db's own getDriver() return
// value carries, without this package needing a direct `neo4j-driver`
// dependency of its own — the type flows in structurally through
// @sentinel-act/graph-db's exports (same pattern regulatory-watch.agent.ts
// uses for Circular via graph-db's re-exported helpers).
type Neo4jDriver = ReturnType<typeof getDriver>;
type Neo4jSession = ReturnType<Neo4jDriver["session"]>;

/** Opens a fresh read session against the singleton driver/database, runs
 *  `work`, and always closes the session — mirrors
 *  packages/graph-db/src/repositories/base.repository.ts's
 *  `openSession()` pattern. */
async function withReadSession<T>(driver: Neo4jDriver, work: (session: Neo4jSession) => Promise<T>): Promise<T> {
  const session = driver.session({ database: getSingletonDatabase() });
  try {
    return await work(session);
  } finally {
    await session.close();
  }
}

export interface SimilarClauseResult {
  clause_id: string;
  para_ref: string;
  similarity: number;
}

/** Vector-similarity search over Clause.embedding_ref (§4.4), excluding
 *  the clause currently being processed. Delegates the actual Neo4j
 *  vector-index Cypher to @sentinel-act/graph-db's own
 *  `findSimilarClauses` (Spec 01 §5.6) rather than re-implementing the
 *  `db.index.vector.queryNodes` call and its Integer-typed `topK`
 *  parameter coercion here — that helper already throws
 *  `GraphDbSchemaError` if the vector index is missing, which the caller
 *  (extractObligations) treats as a GraphRAG-degraded condition per §8. */
export async function findSimilarClausesForClause(
  driver: Neo4jDriver,
  params: { embedding: number[]; excludeClauseId: string; topK: number }
): Promise<SimilarClauseResult[]> {
  const cappedTopK = Math.min(Math.max(params.topK, 1), 20);
  return withReadSession(driver, async (session) => {
    // Over-fetch by one so excluding the current clause (if the index
    // happens to still contain it) doesn't under-fill topK.
    const results = await graphDbFindSimilarClauses(session, {
      queryEmbedding: params.embedding,
      topK: cappedTopK + 1
    });
    return results
      .filter((r) => r.clause.clause_id !== params.excludeClauseId)
      .slice(0, cappedTopK)
      .map((r) => ({
        clause_id: r.clause.clause_id,
        para_ref: r.clause.para_ref,
        similarity: r.score
      }));
  });
}

export interface RelatedObligationResult {
  obligation_id: string;
  category: string;
  clause_id: string;
}

/** Given a list of clause_ids, returns non-rejected Obligation nodes
 *  already DERIVED_FROM those clauses (§4.4). */
export async function findRelatedObligationsForClauses(
  driver: Neo4jDriver,
  clauseIds: string[]
): Promise<RelatedObligationResult[]> {
  if (clauseIds.length === 0) {
    return [];
  }
  return withReadSession(driver, async (session) => {
    const result = await session.executeRead((tx) =>
      tx.run(
        `MATCH (o:Obligation)-[:DERIVED_FROM]->(c:Clause)
         WHERE c.clause_id IN $clauseIds
           AND o.status <> "rejected"
         RETURN o.obligation_id AS obligation_id, o.category AS category, c.clause_id AS clause_id`,
        { clauseIds }
      )
    );
    return result.records.map((record) => ({
      obligation_id: record.get("obligation_id") as string,
      category: record.get("category") as string,
      clause_id: record.get("clause_id") as string
    }));
  });
}

export interface IntermediaryCategoryResult {
  category_id: string;
  name: string;
}

/** Returns the full closed vocabulary of IntermediaryCategory names
 *  (§4.4). May legitimately return an empty array (FR-15). */
export async function listAllIntermediaryCategories(driver: Neo4jDriver): Promise<IntermediaryCategoryResult[]> {
  return withReadSession(driver, async (session) => {
    const result = await session.executeRead((tx) =>
      tx.run(`MATCH (ic:IntermediaryCategory) RETURN ic.category_id AS category_id, ic.name AS name`)
    );
    return result.records.map((record) => ({
      category_id: record.get("category_id") as string,
      name: record.get("name") as string
    }));
  });
}

// ============================================================================
// Mastra Tool wrappers (spec §5.1/§5.5) — thin adapters over the plain
// functions above, wired to the process-wide getDriver() singleton.
// ============================================================================

export const findSimilarClausesTool = createTool({
  id: "find-similar-clauses",
  description:
    "Vector-similarity search over Clause.embedding_ref via the Neo4j native vector index. " +
    "Returns the topK most similar existing clauses, excluding the clause currently being processed.",
  inputSchema: z.object({
    embedding: z.array(z.number()),
    excludeClauseId: z.string(),
    topK: z.number().int().min(1).max(20).default(5)
  }),
  outputSchema: z.object({
    results: z.array(
      z.object({
        clause_id: z.string(),
        para_ref: z.string(),
        similarity: z.number()
      })
    )
  }),
  execute: async (inputData) => {
    const results = await findSimilarClausesForClause(getDriver(), inputData);
    return { results };
  }
});

export const findRelatedObligationsTool = createTool({
  id: "find-related-obligations",
  description: "Given a list of clause_ids, returns non-rejected Obligation nodes already DERIVED_FROM those clauses.",
  inputSchema: z.object({ clauseIds: z.array(z.string()) }),
  outputSchema: z.object({
    results: z.array(
      z.object({
        obligation_id: z.string(),
        category: z.string(),
        clause_id: z.string()
      })
    )
  }),
  execute: async (inputData) => {
    const results = await findRelatedObligationsForClauses(getDriver(), inputData.clauseIds);
    return { results };
  }
});

export const listIntermediaryCategoriesTool = createTool({
  id: "list-intermediary-categories",
  description: "Returns the full closed vocabulary of IntermediaryCategory names.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    results: z.array(z.object({ category_id: z.string(), name: z.string() }))
  }),
  execute: async () => {
    const results = await listAllIntermediaryCategories(getDriver());
    return { results };
  }
});
