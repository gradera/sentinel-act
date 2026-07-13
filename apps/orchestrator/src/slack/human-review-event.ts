// FR-24(a): pure construction of Spec 07's canonical HumanReviewSubmittedEvent
// (imported UNCHANGED — see the `import type` below, which is erased at
// build/test time since it is type-only, meaning this file has NO runtime
// dependency on monitoring-and-audit.agent.ts or anything it imports).
// Extracted out of orchestrator-client.ts into its own file for the same
// reason resume-review-step-error.ts was split out: it lets this specific
// piece of REAL production logic (the exact event shape this unit sends
// to recordHumanReview) be unit-tested in total isolation from Mastra's
// module graph (orchestrator.workflow.ts -> "@mastra/core/workflows"),
// rather than only reachable through a fully-mocked integration test.
//
// This is THE mechanism behind Fix 1 / FR-24's core claim: the graph
// write always uses Spec 07's own HumanReviewSubmittedEvent shape with
// `source: "slack"`, byte-identical in structure to what Spec 09's BFF
// sends with `source: "web-console"` — see
// __tests__/human-review-event-identity.test.ts for the direct regression
// test comparing this function's output against a console-path fixture.
import { randomUUID } from "node:crypto";
import type { ReviewTier } from "@sentinel-act/graph-schema";
import type { HumanReviewSubmittedEvent } from "../mastra/agents/monitoring-and-audit.agent.js";

export interface BuildHumanReviewSubmittedEventInput {
  obligationId: string;
  reviewerId: string;
  tier: ReviewTier | "ESCALATE";
  decision: "approve" | "reject";
  rationale: string | null;
  sourceRef: string | null;
  eventId?: string;
  decidedAt?: string;
}

/** ESCALATE resolves to the wire tier "C" for recordHumanReview's
 *  purposes — graph-schema's ReviewTier has no "ESCALATE" value, and
 *  ESCALATE shares Tier C's exact dual-review claim/suspend mechanics
 *  from the moment it is routed (same convention
 *  apps/web-console/app/api/console/items/[obligationId]/decisions/route.ts's
 *  humanReviewTierFor uses on the console path — see the identity test). */
export function humanReviewTierForSlack(tier: ReviewTier | "ESCALATE"): ReviewTier {
  return tier === "ESCALATE" ? "C" : tier;
}

export function buildHumanReviewSubmittedEvent(input: BuildHumanReviewSubmittedEventInput): HumanReviewSubmittedEvent {
  return {
    event_id: input.eventId ?? randomUUID(),
    obligation_id: input.obligationId,
    reviewer_id: input.reviewerId,
    tier: humanReviewTierForSlack(input.tier),
    decision: input.decision,
    rationale: input.rationale,
    decided_at: input.decidedAt ?? new Date().toISOString(),
    source: "slack",
    source_ref: input.sourceRef
  };
}
