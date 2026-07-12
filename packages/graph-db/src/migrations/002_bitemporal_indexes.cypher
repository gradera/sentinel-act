// FR-2: composite range index on (valid_from, valid_to) plus a separate
// range index on recorded_at for every node label that extends
// Bitemporal (all labels except IntermediaryCategory — see spec §4.2).
// These make the canonical point-in-time predicate (§4.3) an index seek.
CREATE INDEX circular_valid_range IF NOT EXISTS FOR (n:Circular) ON (n.valid_from, n.valid_to);
CREATE INDEX circular_recorded_at IF NOT EXISTS FOR (n:Circular) ON (n.recorded_at);

CREATE INDEX clause_valid_range IF NOT EXISTS FOR (n:Clause) ON (n.valid_from, n.valid_to);
CREATE INDEX clause_recorded_at IF NOT EXISTS FOR (n:Clause) ON (n.recorded_at);

CREATE INDEX obligation_valid_range IF NOT EXISTS FOR (n:Obligation) ON (n.valid_from, n.valid_to);
CREATE INDEX obligation_recorded_at IF NOT EXISTS FOR (n:Obligation) ON (n.recorded_at);

CREATE INDEX process_task_valid_range IF NOT EXISTS FOR (n:ProcessTask) ON (n.valid_from, n.valid_to);
CREATE INDEX process_task_recorded_at IF NOT EXISTS FOR (n:ProcessTask) ON (n.recorded_at);

CREATE INDEX evidence_artifact_valid_range IF NOT EXISTS FOR (n:EvidenceArtifact) ON (n.valid_from, n.valid_to);
CREATE INDEX evidence_artifact_recorded_at IF NOT EXISTS FOR (n:EvidenceArtifact) ON (n.recorded_at);

CREATE INDEX human_review_valid_range IF NOT EXISTS FOR (n:HumanReview) ON (n.valid_from, n.valid_to);
CREATE INDEX human_review_recorded_at IF NOT EXISTS FOR (n:HumanReview) ON (n.recorded_at);
