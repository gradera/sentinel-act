// Repository-layer request/response shapes (spec §4.4). These are
// @sentinel-act/graph-db-local types, not part of @sentinel-act/graph-schema
// — they describe *how you call the DB layer*, not the domain model
// itself. Domain node/edge shapes are imported unchanged from
// @sentinel-act/graph-schema below; nothing here adds, renames, or
// removes a field from those interfaces.
import type {
  Circular,
  Clause,
  Obligation,
  ProcessTask,
  EvidenceArtifact,
  IntermediaryCategory,
  HumanReview,
  GraphEdge
} from "@sentinel-act/graph-schema";

/** Input to create a node: everything except `recorded_at`, which this
 *  layer always stamps server-side from the Neo4j clock (FR-9). Passing
 *  a `recorded_at` is a compile error, and no repository ever
 *  interpolates a client value into that property in Cypher either. */
export type CreateInput<T> = Omit<T, "recorded_at">;

/**
 * A single write intent handed to GraphWriter.commitProposal by the
 * Orchestrator. One CommitPlan = one atomic transaction.
 *
 * TODO(spec-06/08): docs/specs/README.md's "Known cross-spec gaps" flags
 * that Specs 06/08 assume this interface also carries
 * `obligationStatusTransitions` and `finalizeSupersessions` fields. This
 * spec (01) deliberately does NOT add them here — that coordination is
 * explicitly called out as unresolved, and inventing the shape
 * unilaterally would risk guessing wrong about what Specs 06/08 actually
 * need. Whoever implements those specs should extend this interface
 * (additively) once the exact shape is agreed, not silently work around
 * it with parallel types.
 */
export interface CommitPlan {
  /** Idempotency key: the Orchestrator's workflow run id (or step id).
   *  Re-submitting the same proposalId is a safe no-op (see FR-12/15). */
  proposalId: string;
  nodes: {
    circulars?: CreateInput<Circular>[];
    clauses?: CreateInput<Clause>[];
    obligations?: CreateInput<Obligation>[];
    processTasks?: CreateInput<ProcessTask>[];
    evidenceArtifacts?: CreateInput<EvidenceArtifact>[];
    intermediaryCategories?: IntermediaryCategory[];
    humanReviews?: CreateInput<HumanReview>[];
  };
  /** Structural edges to create between nodes referenced above OR
   *  already-committed nodes (matched by their primary key). */
  edges: GraphEdge[];
  /** Zero or more supersession instructions to execute in the same
   *  transaction as the node/edge writes above. See FR-10. */
  supersessions?: SupersessionInstruction[];
}

export interface SupersessionInstruction {
  kind: "Circular" | "Obligation";
  oldId: string; // circular_id or obligation_id being closed
  effectiveDate: string; // ISO date; becomes old.valid_to and (if
  // supplied) new.valid_from
}

export type NodeLabel =
  | "Circular"
  | "Clause"
  | "Obligation"
  | "ProcessTask"
  | "EvidenceArtifact"
  | "IntermediaryCategory"
  | "HumanReview";

export interface CommitResult {
  proposalId: string;
  committedAt: string; // ISO datetime, DB-clock-derived
  nodeCounts: Partial<Record<NodeLabel, number>>;
  edgeCounts: Partial<Record<GraphEdge["type"], number>>;
  supersessionsApplied: number;
}

export interface PointInTimeQuery {
  asOfDate: string; // ISO date, e.g. "2026-07-05"
  categoryName?: string; // filter by IntermediaryCategory.name
  status?: Obligation["status"];
}

export interface VectorSearchQuery {
  queryEmbedding: number[];
  topK: number; // default 5, max 50 (see NFR-6)
  asOfDate?: string; // optional bitemporal filter on the Clause's parent
  // Circular's Obligation set
}

export interface VectorSearchResult {
  clause: Clause;
  score: number; // cosine similarity, 0..1
}
