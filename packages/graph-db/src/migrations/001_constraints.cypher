// FR-1: uniqueness constraint on the primary key of every node label,
// plus IntermediaryCategory.name (functionally unique) and
// Circular.source_hash (post-review addition — required for the
// MERGE ... ON CREATE SET dedup pattern in CircularRepository.create to
// be atomic under concurrent Regulatory Watch polls; see spec §8).
CREATE CONSTRAINT circular_id_unique IF NOT EXISTS FOR (n:Circular) REQUIRE n.circular_id IS UNIQUE;
CREATE CONSTRAINT circular_source_hash_unique IF NOT EXISTS FOR (n:Circular) REQUIRE n.source_hash IS UNIQUE;
CREATE CONSTRAINT clause_id_unique IF NOT EXISTS FOR (n:Clause) REQUIRE n.clause_id IS UNIQUE;
CREATE CONSTRAINT obligation_id_unique IF NOT EXISTS FOR (n:Obligation) REQUIRE n.obligation_id IS UNIQUE;
CREATE CONSTRAINT task_id_unique IF NOT EXISTS FOR (n:ProcessTask) REQUIRE n.task_id IS UNIQUE;
CREATE CONSTRAINT evidence_id_unique IF NOT EXISTS FOR (n:EvidenceArtifact) REQUIRE n.evidence_id IS UNIQUE;
CREATE CONSTRAINT category_id_unique IF NOT EXISTS FOR (n:IntermediaryCategory) REQUIRE n.category_id IS UNIQUE;
CREATE CONSTRAINT category_name_unique IF NOT EXISTS FOR (n:IntermediaryCategory) REQUIRE n.name IS UNIQUE;
CREATE CONSTRAINT review_id_unique IF NOT EXISTS FOR (n:HumanReview) REQUIRE n.review_id IS UNIQUE;
