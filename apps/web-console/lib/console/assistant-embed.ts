// Spec 12 §5.3 step 4 / §13 Open Question 2: `embedQuestion` is a required
// AnswerQuestionDeps dependency for the vector-retrieval (semantic_lookup)
// path. Neither Spec 12 nor its prerequisite (Spec 01, §13 Open Question
// 3) ever picks a real embedding-model provider — Spec 01's seed fixtures
// (packages/graph-db/seed/fixtures/*.ts) populate every Clause.embedding_ref
// with a SYNTHETIC placeholder vector (`Math.sin(seed * 0.017 + i * 0.031)`
// for an arbitrary numeric "seed", not a real embedding of the clause's
// text) purely so migrations/004_vector_index.cypher's 1536-dim vector
// index has something the right shape to index.
//
// ***** HONEST LIMITATION — read before assuming semantic_lookup "works" *****
//
// This file wires `embedQuestion` to a REAL embedding call (via Mastra's
// own model-router, `ModelRouterEmbeddingModel` — the same
// `"provider/model"` string convention classify-question.ts and
// synthesize-answer.ts already use for their LLM calls, so this is one
// consistent mechanism across the whole package, not a second, bespoke
// HTTP client). A real embedding model's output vectors have NO semantic
// relationship whatsoever to Spec 01's synthetic sine-wave placeholder
// vectors already stored on every Clause — cosine similarity between a
// real question embedding and a synthetic seed-based Clause.embedding_ref
// is meaningless noise. This is NOT a bug introduced by this route: it is
// the direct, unavoidable consequence of Spec 01 §13 Open Question 3 still
// being unresolved. `retrieveVector` (packages/assistant-core/src/
// vector-retrieval.ts) will run end-to-end without erroring, but its
// results will not be semantically meaningful until whoever owns Spec 01's
// seed data regenerates `embedding_ref` with this SAME model/provider.
// Flagged here, not silently pretended away — matches this codebase's
// existing convention (see export/route.ts's own "HONEST LIMITATION"
// comment on its fire-and-forget async job path) for documenting a known,
// deliberate gap rather than hiding it.
//
// Configuration:
// - `ASSISTANT_EMBEDDING_MODEL_ID` (default "openai/text-embedding-3-small",
//   matching migrations/004_vector_index.cypher's configured 1536
//   dimensions and the spec's own §13 OQ2 text — "recommended default
//   text-embedding-3-small or equivalent"). Follows Mastra's
//   `"provider/model"` string format, same as `ASSISTANT_MODEL_ID` in
//   classify-question.ts.
// - Whatever API key env var that provider's Mastra gateway expects (e.g.
//   `OPENAI_API_KEY`) must also be set — this file does not read or
//   validate that key itself, it delegates entirely to Mastra's own
//   provider-auth resolution, same as the classifier/synthesis Agents
//   already do.
import { ModelRouterEmbeddingModel } from "@mastra/core/llm";

const DEFAULT_EMBEDDING_MODEL_ID = process.env.ASSISTANT_EMBEDDING_MODEL_ID ?? "openai/text-embedding-3-small";

let cachedModel: ModelRouterEmbeddingModel | undefined;

function getEmbeddingModel(): ModelRouterEmbeddingModel {
  if (!cachedModel) {
    cachedModel = new ModelRouterEmbeddingModel(DEFAULT_EMBEDDING_MODEL_ID);
  }
  return cachedModel;
}

/** `AnswerQuestionDeps["embedQuestion"]`'s real implementation — see
 *  this file's top-of-file "HONEST LIMITATION" comment for what this can
 *  and cannot actually guarantee today. */
export async function embedQuestion(text: string): Promise<number[]> {
  const model = getEmbeddingModel();
  const result = await model.doEmbed({ values: [text] });
  const [embedding] = result.embeddings;
  if (!embedding) {
    throw new Error("embedding provider returned no embedding for the question.");
  }
  return embedding;
}
