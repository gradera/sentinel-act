// vector-retrieval.ts — Spec 12 §4.3, §5.3 step 4, FR-10. Wraps
// findSimilarClauses (Spec 01 §5.6, reused unchanged) and builds an
// AssistantGraphContext from the results. topK is fixed at 5 for this
// unit specifically — tighter than Spec 01's general 50-cap (§7 NFR-5) —
// regardless of what any caller might request; there is no parameter on
// retrieveVector that could raise it. This file MUST NOT import
// GraphWriter, commitProposal, or any repository create()/supersede()
// method (FR-22) — there is no such import below, and there must never be
// one added.
import type { Session } from "neo4j-driver";
import { findSimilarClauses, emptyAssistantGraphContext } from "@sentinel-act/graph-db";
import type { AssistantGraphContext } from "@sentinel-act/graph-db";

// FR-10/§4.3: fixed, not configurable per-call — five clauses is enough
// grounding context for a synthesis prompt without inflating token cost or
// diluting relevance.
export const VECTOR_RETRIEVAL_TOP_K = 5;

export interface VectorRetrievalDeps {
  /** Opens a NEW session on the assistant's read-only driver each call —
   *  retrieveVector owns that session's lifecycle (opens, uses, closes). */
  neo4jSession: () => Session;
  /** Must use the same embedding model/provider/dimension used to
   *  populate Clause.embedding_ref (§13 Open Question 2) — a mismatch
   *  silently breaks every semantic_lookup answer rather than degrading
   *  it, so this is a hard cross-spec consistency requirement, not a
   *  soft alignment note. */
  embedQuestion: (text: string) => Promise<number[]>;
}

/** FR-10: embeds the question and calls findSimilarClauses with
 *  `topK: VECTOR_RETRIEVAL_TOP_K` against the read-only driver's session,
 *  never a caller-supplied topK. Returns an AssistantGraphContext whose
 *  only populated field is `clauses` (plus `vectorScores`) — the vector
 *  path retrieves Clause text directly; it does not additionally hydrate
 *  each clause's parent Circular/derived Obligation (citation hrefs need
 *  only `Clause.circular_id`, already present on every returned clause,
 *  per §4.6's citation convention). */
export async function retrieveVector(
  question: string,
  deps: VectorRetrievalDeps,
  asOfDate?: string
): Promise<AssistantGraphContext> {
  const embedding = await deps.embedQuestion(question);
  const session = deps.neo4jSession();
  try {
    const results = await findSimilarClauses(session, {
      queryEmbedding: embedding,
      topK: VECTOR_RETRIEVAL_TOP_K,
      asOfDate
    });

    const context = emptyAssistantGraphContext();
    const vectorScores: Record<string, number> = {};
    for (const result of results) {
      context.clauses.push({
        clause_id: result.clause.clause_id,
        para_ref: result.clause.para_ref,
        text: result.clause.text,
        circular_id: result.clause.circular_id
      });
      vectorScores[result.clause.clause_id] = result.score;
    }
    context.vectorScores = vectorScores;
    return context;
  } finally {
    await session.close();
  }
}
