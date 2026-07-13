// Type contracts for the Obligation Extraction Agent (Spec 03 §4).
// Colocated in a sibling `.types.ts` (spec task 1 allows either this file
// or inlining in obligation-extraction.agent.ts — split out here so
// confidence-score.ts and graphrag.tools.ts can import without pulling in
// the Mastra Agent/LLM wiring).
//
// No field on `Obligation` is redefined here — `ObligationProposal` is a
// strict subset (graph-assigned fields like `obligation_id`, bitemporal
// fields, `status`, `grounding_score` are the Orchestrator's to set, not
// this agent's — see Spec 03 §5.6).
import type { Clause, IntermediaryCategory } from "@sentinel-act/graph-schema";
import type { obligationCategorySchema } from "./obligation-extraction.schema.js";
import type { z } from "zod";

export type ObligationCategory = z.infer<typeof obligationCategorySchema>;

export interface ObligationExtractionInput {
  /** Full Clause row, including embedding_ref. This agent MUST NOT
   *  re-fetch or re-chunk clause text from any other source (FR-1). */
  clause: Clause;
  circularContext: {
    circular_id: string;
    title: string;
    category: string; // e.g. "Master Circular", "Circular", "FAQ"
    date_effective: string;
  };
  /** All known IntermediaryCategory rows, so the model selects from a
   *  closed vocabulary instead of inventing category names. May be empty
   *  (FR-15) — not an error. */
  knownIntermediaryCategories: IntermediaryCategory[];
}

export interface ConfidenceBreakdown {
  model_self_reported: number; // 0..1, from the LLM's own output
  field_completeness_penalty: number; // 0..1, subtracted
  ambiguity_penalty: number; // 0..1, subtracted
  graphrag_support_bonus: number; // 0..1, added (capped)
  final: number; // clamp(model_self_reported - penalties + bonus, 0, 1)
}

export interface ObligationProposal {
  category: ObligationCategory;
  requirement_text: string;
  trigger_event: string;
  deadline_rule: string; // literal "NONE" if the clause imposes no deadline
  responsible_role: string;
  evidence_required: string;
  penalty_ref: string | null;

  // Not on Obligation directly — resolved to APPLIES_TO edges by the
  // Orchestrator after commit (Spec 03 §5.6, §8 cross-spec note: field
  // name is `applies_to_category_names`, plural, `_names` not `_ids`).
  applies_to_category_names: string[];
  applies_to_unknown_category_names: string[];

  derived_from_clause_id: string;

  confidence_score: number; // 0..1, computed per §6, never the raw model value
  confidence_breakdown: ConfidenceBreakdown;

  /** 0-indexed position of this proposal within the extraction batch for
   *  the same clause — traceability for multi-obligation clauses. */
  extraction_index: number;
}

export interface GraphRagContext {
  similar_clauses: Array<{ clause_id: string; similarity: number; para_ref: string }>;
  related_obligations: Array<{ obligation_id: string; category: ObligationCategory; similarity: number }>;
  /** FR-11/§6.4. Conservative default `true` when GraphRAG retrieval
   *  degrades (Neo4j unavailable) — biases toward Tier B human review
   *  rather than silently under-scrutinizing an obligation the system
   *  couldn't actually check. */
  is_first_seen_obligation_type: boolean;
}

export interface ObligationExtractionOutput {
  clause_id: string;
  circular_id: string;
  proposals: ObligationProposal[]; // empty array = informational-only clause
  informational_only: boolean; // true iff proposals.length === 0
  informational_reason: string | null; // required when informational_only
  graphrag_context: GraphRagContext;
  agent_version: string; // e.g. "obligation-extraction@2026-07-12"
  model_id: string; // resolved model id actually used, for audit (FR-13)
}
