// Public API surface of @sentinel-act/graph-db (spec §5.1). Every other
// spec/package imports from here, not from individual src/ files — this
// is the "never write raw Cypher against this graph outside this package"
// boundary made concrete. Keep this file additive-only across specs
// (do not remove/rename an export once another package depends on it).

// Driver / connection management (§5.2, NFR-2, NFR-3).
export { createDriver, getDriver, closeDriver, verifyConnectivity, getSingletonDatabase } from "./driver.js";
export type { GraphDbConfig } from "./driver.js";

// Error taxonomy (§8).
export {
  GraphDbError,
  ConflictError,
  ValidationError,
  NotFoundError,
  CommitError,
  GraphDbUnavailableError,
  GraphDbSchemaError
} from "./errors.js";

// Repository-layer request/response shapes (§4.4).
export type {
  CreateInput,
  CommitPlan,
  SupersessionInstruction,
  ObligationStatusTransition,
  FinalizeSupersessionInstruction,
  CommitResult,
  NodeLabel,
  PointInTimeQuery,
  VectorSearchQuery,
  VectorSearchResult
} from "./types.js";

// Structured logging (NFR-5) — exported so downstream callers that wrap
// this package's repositories directly (rare, but e.g. a future spec's
// test harness) can emit entries in the same shape.
export { logOperation } from "./logger.js";
export type { LogOperationInput } from "./logger.js";

// Migrations (§5.8, FR-1–FR-6).
export { runMigrations, DEFAULT_MIGRATIONS_DIR } from "./migrations/runner.js";
export type { MigrationRunResult } from "./migrations/runner.js";

// Point-in-time helpers (§5.5, §4.3).
export { pointInTimeWhereClause, findObligationsAsOf } from "./point-in-time.js";

// Vector search (§5.6, FR-20).
export { findSimilarClauses } from "./vector-search.js";

// Repositories (§5.3, §5.4) — one per node type, plus the shared
// GraphRepository contract.
export type { GraphRepository } from "./repositories/base.repository.js";
export { BaseRepository } from "./repositories/base.repository.js";
export { CircularRepository } from "./repositories/circular.repository.js";
// Watch-agent read surface (Spec 02 §3/§4) — see circular-lookups.ts's
// doc comment for why the fuzzy-scoring boundary sits here, not in
// apps/orchestrator.
export { findCircularBySourceHash, findCircularsByTitleFuzzy, titleSimilarity } from "./repositories/circular-lookups.js";
export { ClauseRepository, deserializeClauseNode, fromGraphEmbedding } from "./repositories/clause.repository.js";
export { ObligationRepository } from "./repositories/obligation.repository.js";
export { ProcessTaskRepository } from "./repositories/process-task.repository.js";
export { EvidenceArtifactRepository } from "./repositories/evidence-artifact.repository.js";
export { IntermediaryCategoryRepository } from "./repositories/intermediary-category.repository.js";
export { HumanReviewRepository } from "./repositories/human-review.repository.js";

// Atomic commit path (§5.7, FR-12–FR-15) — the Orchestrator's only write
// entry point.
export { GraphWriter } from "./commit/graph-writer.js";
export { validateCommitPlan, commitPlanSchema } from "./commit/commit-plan-validator.js";
