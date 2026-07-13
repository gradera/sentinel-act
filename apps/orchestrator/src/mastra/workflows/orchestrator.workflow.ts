// The Workflow Orchestrator — deterministic control plane, not an LLM.
// The decision to commit a change to the graph is never made by model
// reasoning: every agent only proposes, this workflow verifies,
// risk-scores via the router, and commits. Its native suspend/resume
// mechanism is the concrete implementation of the Tier A/B/C
// human-in-the-loop gates: a suspended step is a change waiting on a
// human decision (see architecture walkthrough §1).
//
// STUB: wire to Mastra's createWorkflow/createStep + suspend/resume API.
// Verify exact API against current Mastra docs before implementation.

import { regulatoryWatchAgent } from "../agents/regulatory-watch.agent.js";
import { obligationExtractionAgent } from "../agents/obligation-extraction.agent.js";
import { groundingVerificationAgent } from "../agents/grounding-verification.agent.js";
import { mappingRiskScoringAgent } from "../agents/mapping-risk-scoring.agent.js";
import { changeAndDeltaAgent } from "../agents/change-and-delta.agent.js";
import { monitoringAndAuditAgent } from "../agents/monitoring-and-audit.agent.js";
// Spec 05 Task 10: `scoreRisk` and `routeTier` are now owned by
// Spec 05 (Mapping and Risk Scoring Agent + Tier A/B/C Router). The
// two-argument `routeTier(riskScore, hasContradiction)` that used to live
// in this file has been removed — Spec 05's `routeTier(input:
// TierRouteInput)` supersedes it (see Spec 00 §3 for why the object shape
// exists; the two-arg form is historical context only, not the contract
// to implement). Re-exported here so any existing import of `routeTier`/
// `scoreRisk` from this workflow module keeps working without a second
// source of truth.
export { scoreRisk, routeTier } from "../scorers/risk-score.scorer.js";
import type { TierRouteInput } from "../scorers/risk-score.scorer.js";

// Fan-out: the five agents the Orchestrator directly dispatches to.
// (Watch triggers the workflow rather than being fanned out to.)
export const fanOutAgents = [
  obligationExtractionAgent,
  groundingVerificationAgent,
  mappingRiskScoringAgent,
  changeAndDeltaAgent,
  monitoringAndAuditAgent
];

// TODO(Spec 08): building a `TierRouteInput` requires combining this
// unit's `MappingRiskScoringResult` (riskScoreExplain.riskScore,
// firstSeenCheck.isFirstSeenObligationType) with Spec 04's separate
// `hasContradiction`/`verdict` output and the Obligation's own
// confidence_score/grounding_score — that composition is Spec 08's
// responsibility once its workflow steps are wired up (this file is still
// a STUB per the header comment above; verify the exact Mastra
// suspend/resume API before implementing the real step sequence). Type
// re-exported here purely so Spec 08's implementer has it in scope.
export type { TierRouteInput };

export const orchestratorWorkflowStub = {
  name: "sentinel-act-orchestrator",
  trigger: regulatoryWatchAgent.name,
  fanOutAgents: fanOutAgents.map((a) => a.name)
};
