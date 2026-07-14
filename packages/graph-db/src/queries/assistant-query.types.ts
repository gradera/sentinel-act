// Types shared by the Cypher template registry (assistant-query-templates.ts)
// and AssistantQueryService (assistant-query.ts) — Spec 12 §4.1/§5.1. This is
// the canonical definition of AssistantGraphContext: packages/assistant-core
// imports it from this package's public entry point (index.ts) rather than
// redefining it, so the two packages can never drift apart on this shape.
import type { Circular, Clause, HumanReview, Obligation, ProcessTask } from "@sentinel-act/graph-schema";

/** Everything actually retrieved from the graph for one assistant turn —
 *  the only material the synthesis LLM call, and the citation validator,
 *  are allowed to treat as ground truth (§4.1). */
export interface AssistantGraphContext {
  circulars: Pick<Circular, "circular_id" | "title" | "date_issued" | "date_effective">[];
  clauses: Pick<Clause, "clause_id" | "para_ref" | "text" | "circular_id">[];
  obligations: Pick<
    Obligation,
    | "obligation_id"
    | "category"
    | "requirement_text"
    | "trigger_event"
    | "deadline_rule"
    | "responsible_role"
    | "penalty_ref"
    | "status"
    | "confidence_score"
    | "grounding_score"
    | "derived_from_clause_id"
  >[];
  processTasks: Pick<
    ProcessTask,
    "task_id" | "task_name" | "owner_role" | "sla_hours" | "risk_score" | "obligation_id"
  >[];
  humanReviews: Pick<
    HumanReview,
    "review_id" | "reviewer_id" | "tier" | "decision" | "rationale" | "decided_at" | "obligation_id"
  >[];
  /** Present only when the vector-retrieval path ran; cosine similarity per clause_id. */
  vectorScores?: Record<string, number>;
}

export function emptyAssistantGraphContext(): AssistantGraphContext {
  return { circulars: [], clauses: [], obligations: [], processTasks: [], humanReviews: [] };
}

/** FR-14/FR-15: an empty context (across every field) means "no data
 *  found" — synthesizeAnswer is never called for one. */
export function isEmptyAssistantGraphContext(context: AssistantGraphContext): boolean {
  return (
    context.circulars.length === 0 &&
    context.clauses.length === 0 &&
    context.obligations.length === 0 &&
    context.processTasks.length === 0 &&
    context.humanReviews.length === 0
  );
}

/** Shallow-merges two contexts (used by the FR-11 structured-miss →
 *  vector-fallback path in packages/assistant-core/src/index.ts), de-duping
 *  each array by its node's primary id so a node retrieved by both paths
 *  isn't cited/synthesized twice. `vectorScores` from `incoming` wins on key
 *  collision (only the vector path ever sets it). */
export function mergeAssistantGraphContexts(
  base: AssistantGraphContext,
  incoming: AssistantGraphContext
): AssistantGraphContext {
  function dedupeBy<T>(items: T[], keyOf: (item: T) => string): T[] {
    const seen = new Map<string, T>();
    for (const item of items) {
      seen.set(keyOf(item), item);
    }
    return [...seen.values()];
  }

  return {
    circulars: dedupeBy([...base.circulars, ...incoming.circulars], (c) => c.circular_id),
    clauses: dedupeBy([...base.clauses, ...incoming.clauses], (c) => c.clause_id),
    obligations: dedupeBy([...base.obligations, ...incoming.obligations], (o) => o.obligation_id),
    processTasks: dedupeBy([...base.processTasks, ...incoming.processTasks], (t) => t.task_id),
    humanReviews: dedupeBy([...base.humanReviews, ...incoming.humanReviews], (r) => r.review_id),
    vectorScores:
      incoming.vectorScores || base.vectorScores
        ? { ...(base.vectorScores ?? {}), ...(incoming.vectorScores ?? {}) }
        : undefined
  };
}
