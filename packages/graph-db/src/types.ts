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
 * Spec 06/08 additive extensions (`obligationStatusTransitions`,
 * `finalizeSupersessions`) are defined below and wired through
 * commit-plan-validator + GraphWriter.executePlan. Both are OPTIONAL and
 * non-breaking: they add nothing to a plan that doesn't set them, and no
 * existing field was renamed or removed. They implement Spec 08 §4.4's
 * two-phase pre-review/post-review commit pattern (in-place status
 * transition of an already-persisted Obligation, and deferred closing of
 * a superseded Obligation's `valid_to` after the new node it supersedes
 * was created in an earlier commit).
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
  /** Spec 08 §4.4: in-place `status` transitions of already-persisted
   *  Obligation nodes (e.g. tier_b_review -> committed). Executed inside
   *  the same managed transaction as everything else in the plan. */
  obligationStatusTransitions?: ObligationStatusTransition[];
  /** Spec 08 §4.4: closes an already-existing old Obligation's `valid_to`
   *  and links (new)-[:SUPERSEDES]->(old), where the new Obligation was
   *  created by an earlier CommitPlan. Reuses FR-10's `WHERE
   *  old.valid_to IS NULL` guard, so a lost concurrent race throws
   *  ConflictError identically to a `supersede()` conflict. */
  finalizeSupersessions?: FinalizeSupersessionInstruction[];
}

export interface SupersessionInstruction {
  kind: "Circular" | "Obligation";
  oldId: string; // circular_id or obligation_id being closed
  effectiveDate: string; // ISO date; becomes old.valid_to and (if
  // supplied) new.valid_from
}

/** Spec 08 §4.4: transition an already-persisted Obligation's `status`
 *  field in place. Creates no node. */
export interface ObligationStatusTransition {
  obligation_id: string;
  newStatus: Obligation["status"]; // any value in the ObligationStatus enum
}

/** Spec 08 §4.4: the new Obligation MUST already exist in the graph
 *  (created by an earlier CommitPlan). This instruction only closes the
 *  old node's `valid_to` and (idempotently) links
 *  (new)-[:SUPERSEDES]->(old); it creates no node. */
export interface FinalizeSupersessionInstruction {
  oldObligationId: string;
  newObligationId: string;
  effectiveDate: string; // ISO date
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
