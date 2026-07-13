// Deterministic risk scorer used by Mapping and Risk Scoring (Spec 05).
// Inputs mirror ProcessTask.risk_score's stated drivers: penalty
// severity, deadline proximity, and whether the change touches a
// currently live Obligation. This file also owns the Tier A/B/C
// Router (`routeTier`) and every shared data contract Spec 05 defines
// (Spec 05 §4) — the mapping-side logic (deriveTaskName, etc.) lives in
// `../agents/mapping-risk-scoring.agent.ts` and its sibling files;
// this file is deliberately the single source of truth for types that
// downstream specs (06, 08, 09, 11, 13) import.
//
// FR-3 / NFR-2: this file MUST NEVER import an LLM/model client. Every
// function here is pure and synchronous (routeTier) or declares the
// narrow async I/O contract (GraphQueryPort) other files implement —
// there is no model call anywhere in this unit, by construction.

import type { ProcessTask, ReviewTier } from "@sentinel-act/graph-schema";

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/** Everything the Orchestrator needs to create a ProcessTask node, minus
 *  fields the Orchestrator itself assigns at commit time (task_id and the
 *  three bitemporal fields, which are stamped when the node is actually
 *  written to Neo4j — this unit never writes to the graph, per NFR-7). */
export type ProcessTaskDraft = Omit<ProcessTask, "task_id" | "valid_from" | "valid_to" | "recorded_at">;

// ---------------------------------------------------------------------------
// Minimal read-only graph access this unit needs
// ---------------------------------------------------------------------------
// Satisfied by whatever client Spec 01 (@sentinel-act/graph-db) exports;
// this is the narrowest interface this unit depends on, so it can be
// unit-tested with a fake and so this unit does not couple to Spec 01's
// exact export names (Spec 05 §3, dependency note: "if Spec 01 names it
// differently, adapt the import, not the contract"). See
// `mapping-risk-scoring.graph.ts` for the real neo4j-driver-backed adapter.
export interface GraphQueryPort {
  runCypher<T = Record<string, unknown>>(query: string, params: Record<string, unknown>): Promise<T[]>;
}

export interface MappingContext {
  graph: GraphQueryPort;
  /** ISO date used as "now" for deadline-proximity and SLA math. Always
   *  pass explicitly (never call Date.now() inside pure helpers) so tests
   *  and audit replay are deterministic (FR-2). Orchestrator supplies
   *  workflow-run time. */
  referenceDate: string;
  /** Graph query timeout budget in ms — see NFR-4 and Error Handling §8. */
  graphTimeoutMs?: number; // default 2000
}

export const DEFAULT_GRAPH_TIMEOUT_MS = 2000;

// ---------------------------------------------------------------------------
// Risk scoring
// ---------------------------------------------------------------------------

export interface RiskScoreInputs {
  penaltySeverity: number; // 0..1
  deadlineProximityDays: number; // >= 0
  overwritesLiveObligation: boolean;
}

export interface RiskScoreExplain extends RiskScoreInputs {
  riskScore: number; // 0..1, the scoreRisk() output
  deadlineWeight: number; // intermediate term, logged for audit
  overwriteWeight: number; // intermediate term, logged for audit
}

/** Deadline-proximity weight: closer deadline -> higher weight. Exported
 *  so `explainRiskScore` and any caller that wants the raw intermediate
 *  term (audit/logging) does not need to recompute it by hand. */
export function deadlineWeightOf(deadlineProximityDays: number): number {
  return Math.max(0, 1 - deadlineProximityDays / 30);
}

/** Existing signature, unchanged (Spec 05 §5 explicitly calls this out —
 *  do not change this function's shape; `explainRiskScore` below is the
 *  additive companion that also returns the intermediate terms). Formula
 *  and clamping are unchanged from the original stub (NFR-6, §8's
 *  "riskScore computation somehow yields a value outside [0,1]" row). */
export function scoreRisk({ penaltySeverity, deadlineProximityDays, overwritesLiveObligation }: RiskScoreInputs): number {
  const deadlineWeight = deadlineWeightOf(deadlineProximityDays); // closer deadline -> higher weight
  const overwriteWeight = overwritesLiveObligation ? 0.3 : 0;
  const raw = penaltySeverity * 0.5 + deadlineWeight * 0.3 + overwriteWeight;
  return Math.min(1, Math.max(0, raw));
}

/** Task 8: extends `scoreRisk` to also surface the `RiskScoreExplain`
 *  intermediate terms (NFR-3) without changing `scoreRisk`'s own
 *  signature. Calls `scoreRisk` internally so the two can never drift. */
export function explainRiskScore(inputs: RiskScoreInputs): RiskScoreExplain {
  const deadlineWeight = deadlineWeightOf(inputs.deadlineProximityDays);
  const overwriteWeight = inputs.overwritesLiveObligation ? 0.3 : 0;
  return {
    ...inputs,
    riskScore: scoreRisk(inputs),
    deadlineWeight,
    overwriteWeight
  };
}

// ---------------------------------------------------------------------------
// Overwrite / first-seen graph lookups
// ---------------------------------------------------------------------------

export interface OverwriteCheckResult {
  overwritesLiveObligation: boolean;
  /** Which lookup path matched, or null if neither did. Logged for audit;
   *  "explicit" is high-confidence (circular-level SUPERSEDES chain),
   *  "heuristic" is a same-category/role fallback match (see FR-19). */
  matchPath: "explicit" | "heuristic" | null;
  /** obligation_id of the live Obligation that would be overwritten, if any. */
  overwrittenObligationId: string | null;
  /** true if the graph lookup could not complete and a fail-closed default
   *  was used instead (see Error Handling §8). */
  degraded: boolean;
}

export interface FirstSeenCheckResult {
  isFirstSeenObligationType: boolean;
  degraded: boolean;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface TierRouteInput {
  riskScore: number; // 0..1, from scoreRisk()
  hasContradiction: boolean; // from Spec 04's Grounding and Verification output
  confidenceScore: number; // 0..1, Obligation.confidence_score
  groundingScore: number; // 0..1, Obligation.grounding_score
  isFirstSeenObligationType: boolean; // from isFirstSeenObligationType()
}

export type TierRouteReason =
  | "CONTRADICTION"
  | "GROUNDING_FAILURE"
  | "RISK_SCORE_TIER_C"
  | "RISK_SCORE_TIER_B"
  | "SUB_THRESHOLD_CONFIDENCE_OR_GROUNDING"
  | "FIRST_SEEN_OBLIGATION_TYPE"
  | "BASE_TIER_A";

export interface TierDecision {
  tier: ReviewTier | "ESCALATE";
  /** Every rule that fired, in evaluation order, for audit/explainability.
   *  Always non-empty. Spec 07 persists this array verbatim to the
   *  Hash-chained Audit Ledger alongside the HumanReview / commit event. */
  reasons: TierRouteReason[];
}

// FR-13/§13: unconfirmed placeholders pending compliance-team sign-off.
// Named exported constants (never magic numbers) so they are a one-line
// change once real thresholds are confirmed.
export const GROUNDING_FAILURE_THRESHOLD = 0.5;
export const CONFIDENCE_HIGH_THRESHOLD = 0.85;
export const GROUNDING_HIGH_THRESHOLD = 0.85;
export const RISK_TIER_C_THRESHOLD = 0.75;
export const RISK_TIER_B_THRESHOLD = 0.4;

/** FR-22–FR-30: pure, synchronous, no I/O. All five `TierRouteInput`
 *  fields MUST already be resolved by the caller (`runMappingAndRiskScoring`
 *  plus the Orchestrator's own `hasContradiction` from Spec 04) before this
 *  is invoked. Evaluation order below is load-bearing — do not reorder
 *  without a coordinated update across Specs 06/08/09/11/13 (Spec 05 §9). */
export function routeTier(input: TierRouteInput): TierDecision {
  const { riskScore, hasContradiction, confidenceScore, groundingScore, isFirstSeenObligationType } = input;

  // FR-23/FR-24: escalation is evaluated first, unconditionally. No other
  // input — including a high confidenceScore — can override this.
  const escalationReasons: TierRouteReason[] = [];
  if (hasContradiction) {
    escalationReasons.push("CONTRADICTION");
  }
  if (groundingScore < GROUNDING_FAILURE_THRESHOLD) {
    escalationReasons.push("GROUNDING_FAILURE");
  }
  if (escalationReasons.length > 0) {
    return { tier: "ESCALATE", reasons: escalationReasons };
  }

  // FR-25: inclusive lower bounds. riskScore === 0.75 -> "C" (not "B");
  // riskScore === 0.4 -> "B" (not "A").
  let baseTier: ReviewTier;
  let baseReason: TierRouteReason;
  if (riskScore >= RISK_TIER_C_THRESHOLD) {
    baseTier = "C";
    baseReason = "RISK_SCORE_TIER_C";
  } else if (riskScore >= RISK_TIER_B_THRESHOLD) {
    baseTier = "B";
    baseReason = "RISK_SCORE_TIER_B";
  } else {
    baseTier = "A";
    baseReason = "BASE_TIER_A"; // provisional — may be overwritten below by an upgrade reason set
  }

  // FR-26: a risk-score-earned "B" or "C" is final — confidence/first-seen
  // never downgrade or upgrade it further.
  if (baseTier !== "A") {
    return { tier: baseTier, reasons: [baseReason] };
  }

  // FR-27/FR-28: baseTier === "A" — check Tier-A eligibility and
  // first-seen independently; both can fire together (FR-27/FR-28 note).
  const reasons: TierRouteReason[] = [];
  const eligibleForTierA = confidenceScore >= CONFIDENCE_HIGH_THRESHOLD && groundingScore >= GROUNDING_HIGH_THRESHOLD;
  if (!eligibleForTierA) {
    reasons.push("SUB_THRESHOLD_CONFIDENCE_OR_GROUNDING");
  }
  if (isFirstSeenObligationType) {
    reasons.push("FIRST_SEEN_OBLIGATION_TYPE");
  }

  if (reasons.length > 0) {
    // FR-27/FR-28: either failure upgrades "A" to "B".
    return { tier: "B", reasons };
  }

  // FR-29: both checks passed — final tier is "A".
  return { tier: "A", reasons: ["BASE_TIER_A"] };
}
