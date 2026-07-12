// FR-4: supporting lookup indexes for hot-path FK traversals.
CREATE INDEX obligation_derived_from_clause_id IF NOT EXISTS FOR (n:Obligation) ON (n.derived_from_clause_id);
CREATE INDEX obligation_status IF NOT EXISTS FOR (n:Obligation) ON (n.status);
CREATE INDEX clause_circular_id IF NOT EXISTS FOR (n:Clause) ON (n.circular_id);
CREATE INDEX process_task_obligation_id IF NOT EXISTS FOR (n:ProcessTask) ON (n.obligation_id);
CREATE INDEX evidence_artifact_task_id IF NOT EXISTS FOR (n:EvidenceArtifact) ON (n.task_id);
CREATE INDEX human_review_obligation_id IF NOT EXISTS FOR (n:HumanReview) ON (n.obligation_id);
