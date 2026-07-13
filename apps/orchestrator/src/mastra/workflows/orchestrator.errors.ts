// Typed errors for the Workflow Orchestrator's resume path (Spec 08 §8).
// These are thrown by `resumeOrchestratorRun` BEFORE any `run.resume(...)`
// or `recordHumanReview(...)` call, so a bad resume payload never mutates
// graph or workflow state.

export class OrchestratorError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** FR-21 / §8: the resume payload's runId/obligation_id/stepId did not
 *  match the suspended run recorded by SuspendedRunIndexPort (stale or
 *  forged payload). No resume attempted. */
export class ResumeValidationError extends OrchestratorError {}

/** FR-25 / §8: the checker slot's reviewer_id matches the maker's — a
 *  cheap early rejection before FR-21a's `recordHumanReview` call (which
 *  independently re-checks the same rule as the authoritative backstop).
 *  No resume attempted, no recordHumanReview call made. */
export class ReviewerIndependenceError extends OrchestratorError {}

/** FR-24a: the review-gate / claim endpoint was called without a valid
 *  service-to-service JWT (SENTINEL_SERVICE_JWT_SECRET). */
export class ServiceAuthError extends OrchestratorError {}
