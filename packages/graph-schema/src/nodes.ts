// Node types for the bitemporal Regulatory Knowledge Graph.
// Mirrors Sentinel_Act_Knowledge_Graph_Schema.png (v1.1, production schema).
// Every node carries valid_from / valid_to (regulatory effective window)
// and recorded_at (when Sentinel Act's pipeline asserted the fact).

export interface Bitemporal {
  valid_from: string; // ISO date
  valid_to: string | null;
  recorded_at: string; // ISO datetime
}

export interface Circular extends Bitemporal {
  circular_id: string; // uuid v4
  title: string;
  type: string;
  category: string;
  date_issued: string;
  date_effective: string;
  source_hash: string; // sha256
  supersedes_circular_id: string | null;
}

export interface Clause extends Bitemporal {
  clause_id: string;
  circular_id: string; // FK -> Circular
  para_ref: string;
  text: string;
  embedding_ref: string;
}

export type ObligationStatus = "proposed" | "tier_a_committed" | "tier_b_review" | "tier_c_review" | "escalated" | "committed" | "rejected";

export interface Obligation extends Bitemporal {
  obligation_id: string;
  derived_from_clause_id: string; // FK -> Clause
  category: string;
  requirement_text: string;
  trigger_event: string;
  deadline_rule: string;
  responsible_role: string;
  evidence_required: string;
  penalty_ref: string | null;
  confidence_score: number; // 0..1
  grounding_score: number; // 0..1
  status: ObligationStatus;
}

export interface ProcessTask extends Bitemporal {
  task_id: string;
  obligation_id: string; // FK -> Obligation
  task_name: string;
  owner_role: string;
  sla_hours: number;
  system_touchpoint: string;
  risk_score: number; // 0..1, drives Tier A/B/C routing
}

export interface EvidenceArtifact extends Bitemporal {
  evidence_id: string;
  task_id: string; // FK -> ProcessTask
  type: string;
  hash: string; // sha256, tamper evidence
  uploaded_at: string;
  uploaded_by: string;
}

export interface IntermediaryCategory {
  category_id: string;
  name: string; // e.g. "Stockbroker", "Investment Adviser"
}

export type ReviewTier = "A" | "B" | "C";
export type ReviewDecision = "approve" | "reject";

export interface HumanReview extends Bitemporal {
  review_id: string;
  obligation_id: string; // FK -> Obligation
  reviewer_id: string;
  tier: ReviewTier;
  decision: ReviewDecision;
  rationale: string | null; // required at Tier C
  decided_at: string;
}
