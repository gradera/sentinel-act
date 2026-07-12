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
import { scoreRisk } from "../scorers/risk-score.scorer.js";
import type { ReviewTier } from "@sentinel-act/graph-schema";

// Fan-out: the five agents the Orchestrator directly dispatches to.
// (Watch triggers the workflow rather than being fanned out to.)
export const fanOutAgents = [
  obligationExtractionAgent,
  groundingVerificationAgent,
  mappingRiskScoringAgent,
  changeAndDeltaAgent,
  monitoringAndAuditAgent
];

export function routeTier(riskScore: number, hasContradiction: boolean): ReviewTier | "ESCALATE" {
  if (hasContradiction) return "ESCALATE";
  if (riskScore >= 0.75) return "C";
  if (riskScore >= 0.4) return "B";
  return "A";
}

export const orchestratorWorkflowStub = {
  name: "sentinel-act-orchestrator",
  trigger: regulatoryWatchAgent.name,
  fanOutAgents: fanOutAgents.map((a) => a.name),
  scoreRisk,
  routeTier
};
