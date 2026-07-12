// Edge types for the Regulatory Knowledge Graph.
// Cardinality notes mirror the schema doc: 1 = exactly one, N = many, 0..1 = optional.

export interface Supersedes {
  type: "SUPERSEDES";
  // Circular -> Circular (0..1:0..1) or Obligation -> Obligation (0..1:0..1)
  from_id: string;
  to_id: string;
}

export interface PartOf {
  type: "PART_OF";
  // Clause -> Circular (N:1)
  clause_id: string;
  circular_id: string;
}

export interface DerivedFrom {
  type: "DERIVED_FROM";
  // Obligation -> Clause (N:1)
  obligation_id: string;
  clause_id: string;
}

export interface AppliesTo {
  type: "APPLIES_TO";
  // Obligation -> IntermediaryCategory (N:N) -- the only many-to-many edge
  obligation_id: string;
  category_id: string;
}

export interface MappedTo {
  type: "MAPPED_TO";
  // Obligation -> ProcessTask (1:N)
  obligation_id: string;
  task_id: string;
}

export interface EvidencedBy {
  type: "EVIDENCED_BY";
  // ProcessTask -> EvidenceArtifact (1:N)
  task_id: string;
  evidence_id: string;
}

export interface ReviewedBy {
  type: "REVIEWED_BY";
  // Obligation -> HumanReview (1:N); a Tier C item carries two
  obligation_id: string;
  review_id: string;
}

export type GraphEdge =
  | Supersedes
  | PartOf
  | DerivedFrom
  | AppliesTo
  | MappedTo
  | EvidencedBy
  | ReviewedBy;
