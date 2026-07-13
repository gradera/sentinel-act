// @sentinel-act/review-contracts — Spec 11 §3/§13: shared review-gate and
// decision-submission types consumed by both apps/web-console (Spec 09)
// and apps/orchestrator/src/slack (Spec 11), plus this unit's own
// telemetry event type (Spec 11 §4, Fix 1). See console-types.ts and
// events.ts for the full doc-comment history of each export.

export type {
  ReviewerRole,
  ReviewerSession,
  SlaState,
  TierCGateStatus,
  TierCReviewGateView,
  TierBReviewGateView,
  EscalateReviewGateView,
  ReviewGateView,
  DecisionAction,
  SubmitDecisionRequest,
  SubmitDecisionResponse
} from "./console-types.js";

export { deriveQueueSummary, truncateRequirementText } from "./summary.js";

export type { ReviewWorkflowState, ReviewSubmissionTelemetryEvent } from "./events.js";
