// Extracted from orchestrator-client.ts so this error class has NO
// transitive dependency on orchestrator.workflow.ts (which imports
// @mastra/core/workflows). This lets test doubles for
// getReviewGate/claimReviewSlot/resumeReviewStep (via vi.mock on
// "./orchestrator-client.js") throw/import the REAL error class — so
// `instanceof ResumeReviewStepError` checks in view-submissions.ts still
// work against a mocked backend — without ever loading the real Mastra
// workflow module in a test process. Not a design requirement from the
// spec text itself; a pragmatic split driven by keeping this unit's
// handler logic unit-testable in isolation from Mastra's own module
// graph, same spirit as orchestrator.logic.ts being split out from
// orchestrator.workflow.ts for the same reason.

export type ResumeReviewStepErrorCode =
  | "RATIONALE_REQUIRED"
  | "ALREADY_DECIDED"
  | "NOT_ASSIGNED"
  | "SELF_REVIEW_FORBIDDEN"
  | "SUSPENDED_STEP_NOT_FOUND"
  | "VALIDATION_ERROR";

export class ResumeReviewStepError extends Error {
  constructor(
    public readonly code: ResumeReviewStepErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "ResumeReviewStepError";
  }
}
