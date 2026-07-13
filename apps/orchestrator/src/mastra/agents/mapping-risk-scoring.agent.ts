// Mapping and Risk Scoring Agent — deliberately NOT an LLM call (Spec 05).
// Deterministic, rules-based: maps an Obligation to a ProcessTask and
// computes risk_score from penalty severity, deadline proximity, and
// whether it touches a currently live obligation. This score (plus the
// contradiction/confidence/grounding signals) is what the Tier A/B/C
// Router (`routeTier`, in ../scorers/risk-score.scorer.ts) acts on.
//
// FR-3/NFR-2: this file, and every file it imports, MUST NEVER import an
// LLM/model client. If a future change to this unit ever needs one, that
// is a bug, not a design choice.
import type { Obligation } from "@sentinel-act/graph-schema";
import type {
  ProcessTaskDraft,
  MappingContext,
  RiskScoreExplain,
  OverwriteCheckResult,
  FirstSeenCheckResult
} from "../scorers/risk-score.scorer.js";
import { explainRiskScore } from "../scorers/risk-score.scorer.js";
import { deriveOverwritesLiveObligation, isFirstSeenObligationType } from "./mapping-risk-scoring.graph.js";
import { parseDeadlineRule, parseIndianRupeeAmount } from "./mapping-risk-scoring.parsers.js";
import {
  ROLE_MAP,
  TOUCHPOINT_RULES,
  TOUCHPOINT_FALLBACK,
  PENALTY_BAND_TABLE,
  SEVERE_KEYWORDS,
  ADVISORY_KEYWORDS,
  PENALTY_KEYWORD,
  ONE_LAKH,
  TEN_LAKH,
  ONE_CRORE
} from "./mapping-risk-scoring.tables.js";
import { MappingValidationError } from "./mapping-risk-scoring.errors.js";

export { deriveOverwritesLiveObligation, isFirstSeenObligationType } from "./mapping-risk-scoring.graph.js";

// ---------------------------------------------------------------------------
// Mapping — task_name (FR-4)
// ---------------------------------------------------------------------------

const TASK_NAME_TRUNCATION_LIMIT = 100;
const SENTENCE_BOUNDARY_PATTERN = /[.;\n]/;

export function deriveTaskName(obligation: Obligation): string {
  const text = obligation.requirement_text ?? "";
  if (text.trim().length === 0) {
    return `${obligation.category} — (no requirement text)`;
  }

  const boundaryMatch = SENTENCE_BOUNDARY_PATTERN.exec(text);
  let firstSentence: string;
  let truncatedAtCharBound = false;

  if (boundaryMatch && boundaryMatch.index < TASK_NAME_TRUNCATION_LIMIT) {
    firstSentence = text.slice(0, boundaryMatch.index);
  } else if (text.length > TASK_NAME_TRUNCATION_LIMIT) {
    firstSentence = text.slice(0, TASK_NAME_TRUNCATION_LIMIT);
    truncatedAtCharBound = true;
  } else {
    firstSentence = text;
  }

  firstSentence = firstSentence.trim();
  if (truncatedAtCharBound) {
    firstSentence += "…";
  }
  return `${obligation.category} — ${firstSentence}`;
}

// ---------------------------------------------------------------------------
// Mapping — owner_role (FR-5)
// ---------------------------------------------------------------------------

/** Trim, collapse internal whitespace, title-case — the normalized form
 *  both `ROLE_MAP`'s keys and the identity fallback use. */
export function normalizeRoleText(input: string): string {
  return input
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((word) => (word.length === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
    .join(" ");
}

export function deriveOwnerRole(responsibleRole: string): string {
  const normalized = normalizeRoleText(responsibleRole ?? "");
  return ROLE_MAP[normalized] ?? normalized;
}

// ---------------------------------------------------------------------------
// Mapping — sla_hours / deadline proximity (FR-6, FR-7, FR-8, FR-14, FR-15)
// ---------------------------------------------------------------------------

const HOURS_PER_DAY = 24;
const PERIOD_DAYS: Readonly<Record<"annual" | "quarterly" | "monthly" | "weekly", number>> = Object.freeze({
  annual: 365,
  quarterly: 90,
  monthly: 30,
  weekly: 7
});

// FR-7 Type D / FR-14 Type D.
const TYPE_D_SLA_HOURS = 24;
// FR-7 Type E / FR-14 Type E fallback placeholders.
const TYPE_E_SLA_HOURS = 720; // 30 days
const TYPE_E_DEADLINE_PROXIMITY_DAYS = 90;

function hoursUntil(referenceDate: string, isoDate: string): number {
  const reference = new Date(referenceDate).getTime();
  const target = new Date(isoDate).getTime();
  const diffHours = (target - reference) / (1000 * 60 * 60);
  return Math.max(0, Math.round(diffHours));
}

function daysUntil(referenceDate: string, isoDate: string): number {
  const reference = new Date(referenceDate).getTime();
  const target = new Date(isoDate).getTime();
  const diffDays = (target - reference) / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.round(diffDays));
}

/** FR-7. Every fallback branch (Types D/E, an unparseable Type C date, or
 *  any Type A/B/C match with an uncaptured/unparseable numeric group) is
 *  tagged `slaConfidence: "low"` (FR-8) alongside the numeric result. */
export function deriveSlaHoursExplain(deadlineRule: string, referenceDate: string): { hours: number; slaConfidence: "high" | "low" } {
  const classification = parseDeadlineRule(deadlineRule);

  switch (classification.type) {
    case "A": {
      const hours = classification.unit === "hour" ? classification.amount : classification.amount * HOURS_PER_DAY;
      return { hours, slaConfidence: classification.lowConfidence ? "low" : "high" };
    }
    case "B":
      return { hours: PERIOD_DAYS[classification.period] * HOURS_PER_DAY, slaConfidence: "high" };
    case "C":
      if (!classification.isoDate) {
        // "by ..." shape matched but the date itself didn't resolve —
        // degrade to the Type E fallback rather than throwing (§8).
        return { hours: TYPE_E_SLA_HOURS, slaConfidence: "low" };
      }
      return { hours: hoursUntil(referenceDate, classification.isoDate), slaConfidence: "high" };
    case "D":
      return { hours: TYPE_D_SLA_HOURS, slaConfidence: "low" };
    case "E":
      return { hours: TYPE_E_SLA_HOURS, slaConfidence: "low" };
  }
}

export function deriveSlaHours(deadlineRule: string, referenceDate: string): number {
  return deriveSlaHoursExplain(deadlineRule, referenceDate).hours;
}

/** FR-14/FR-15. Reuses the same classifier as `deriveSlaHours` (FR-6) but
 *  a distinct interpretation: Types A/B read as window/period *length*
 *  (how tight the response window is), not a calendar countdown, since at
 *  mapping time there is no dated instance of the trigger_event yet. */
export function deriveDeadlineProximityDaysExplain(
  deadlineRule: string,
  referenceDate: string
): { days: number; slaConfidence: "high" | "low" } {
  const classification = parseDeadlineRule(deadlineRule);

  switch (classification.type) {
    case "A": {
      // N converted to days: hours / 24, rounded up (FR-14).
      const hours = classification.unit === "hour" ? classification.amount : classification.amount * HOURS_PER_DAY;
      const days = Math.max(0, Math.ceil(hours / HOURS_PER_DAY));
      return { days, slaConfidence: classification.lowConfidence ? "low" : "high" };
    }
    case "B":
      return { days: PERIOD_DAYS[classification.period], slaConfidence: "high" };
    case "C":
      if (!classification.isoDate) {
        return { days: TYPE_E_DEADLINE_PROXIMITY_DAYS, slaConfidence: "low" };
      }
      return { days: daysUntil(referenceDate, classification.isoDate), slaConfidence: "high" };
    case "D":
      return { days: 0, slaConfidence: "high" };
    case "E":
      return { days: TYPE_E_DEADLINE_PROXIMITY_DAYS, slaConfidence: "low" };
  }
}

export function deriveDeadlineProximityDays(deadlineRule: string, referenceDate: string): number {
  return deriveDeadlineProximityDaysExplain(deadlineRule, referenceDate).days;
}

// ---------------------------------------------------------------------------
// Mapping — system_touchpoint (FR-9)
// ---------------------------------------------------------------------------

function matchTouchpointRule(text: string): string | null {
  const lower = text.toLowerCase();
  for (const rule of TOUCHPOINT_RULES) {
    if (rule.keywords.some((keyword) => lower.includes(keyword))) {
      return rule.touchpoint;
    }
  }
  return null;
}

export function deriveSystemTouchpoint(obligation: Obligation): string {
  return matchTouchpointRule(obligation.category ?? "") ?? matchTouchpointRule(obligation.requirement_text ?? "") ?? TOUCHPOINT_FALLBACK;
}

// ---------------------------------------------------------------------------
// Risk scoring — penaltySeverity (FR-11, FR-12, FR-13)
// ---------------------------------------------------------------------------

export function derivePenaltySeverity(penaltyRef: string | null): number {
  if (!penaltyRef || penaltyRef.trim().length === 0) {
    return 0; // FR-11
  }

  const lower = penaltyRef.toLowerCase();

  if (SEVERE_KEYWORDS.some((keyword) => lower.includes(keyword))) {
    return PENALTY_BAND_TABLE.severe.severity;
  }

  if (lower.includes(PENALTY_KEYWORD)) {
    const amount = parseIndianRupeeAmount(penaltyRef);
    if (amount === null) {
      return PENALTY_BAND_TABLE.monetary_unspecified.severity;
    }
    if (amount >= ONE_CRORE) {
      return PENALTY_BAND_TABLE.monetary_high.severity;
    }
    if (amount >= TEN_LAKH) {
      return PENALTY_BAND_TABLE.monetary_medium.severity;
    }
    if (amount >= ONE_LAKH) {
      return PENALTY_BAND_TABLE.monetary_low.severity;
    }
    return PENALTY_BAND_TABLE.monetary_sub_lakh.severity;
  }

  if (ADVISORY_KEYWORDS.some((keyword) => lower.includes(keyword))) {
    return PENALTY_BAND_TABLE.advisory.severity;
  }

  return PENALTY_BAND_TABLE.unrecognized_non_empty.severity; // FR-12, last row / FR-13
}

// ---------------------------------------------------------------------------
// FR-1/§8: precondition validation
// ---------------------------------------------------------------------------

const REQUIRED_OBLIGATION_FIELDS: ReadonlyArray<keyof Obligation> = [
  "obligation_id",
  "category",
  "requirement_text",
  "trigger_event",
  "deadline_rule",
  "responsible_role",
  "derived_from_clause_id"
];

/** §8: "Obligation missing a required field entirely ... should not happen
 *  post-Spec-03 validation, but this unit must not assume it." Note
 *  `penalty_ref` is intentionally excluded — it is legitimately nullable
 *  (FR-11). */
function validateObligation(obligation: Obligation): void {
  for (const field of REQUIRED_OBLIGATION_FIELDS) {
    if (obligation[field] === undefined) {
      throw new MappingValidationError(`Obligation is missing required field "${String(field)}"`, String(field));
    }
  }
}

// ---------------------------------------------------------------------------
// Composition — mapObligationToProcessTask (FR-10) and
// runMappingAndRiskScoring (the Orchestrator's actual entry point)
// ---------------------------------------------------------------------------

interface RiskScoringComponents {
  overwriteCheck: OverwriteCheckResult;
  firstSeenCheck: FirstSeenCheckResult;
  riskScoreExplain: RiskScoreExplain;
  /** FR-8: "every fallback branch in FR-7 ... MUST be tagged internally as
   *  slaConfidence: 'low' and surfaced in the returned explain object so
   *  Spec 07 can log it." Post-review correction: an earlier version of
   *  this unit computed this flag (deriveSlaHoursExplain /
   *  deriveDeadlineProximityDaysExplain) but then discarded it by calling
   *  the non-explain wrappers here — it never actually reached
   *  MappingRiskScoringResult or the audit log, silently failing FR-8's
   *  "surfaced" requirement despite the flag existing internally. Fixed by
   *  threading it through to the top-level result below. */
  slaConfidence: "high" | "low";
}

/** Shared by both `mapObligationToProcessTask` and
 *  `runMappingAndRiskScoring` so each top-level call issues exactly one
 *  round trip for each of the two graph queries (NFR-1's latency budget),
 *  not two. */
async function computeRiskScoringComponents(obligation: Obligation, ctx: MappingContext): Promise<RiskScoringComponents> {
  const [overwriteCheck, firstSeenCheck] = await Promise.all([
    deriveOverwritesLiveObligation(obligation, ctx),
    isFirstSeenObligationType(obligation, ctx)
  ]);

  const penaltySeverity = derivePenaltySeverity(obligation.penalty_ref);
  const deadlineExplain = deriveDeadlineProximityDaysExplain(obligation.deadline_rule, ctx.referenceDate);

  const riskScoreExplain = explainRiskScore({
    penaltySeverity,
    deadlineProximityDays: deadlineExplain.days,
    overwritesLiveObligation: overwriteCheck.overwritesLiveObligation
  });

  return { overwriteCheck, firstSeenCheck, riskScoreExplain, slaConfidence: deadlineExplain.slaConfidence };
}

function buildProcessTaskDraft(obligation: Obligation, ctx: MappingContext, riskScore: number): ProcessTaskDraft {
  return {
    obligation_id: obligation.obligation_id,
    task_name: deriveTaskName(obligation),
    owner_role: deriveOwnerRole(obligation.responsible_role),
    sla_hours: deriveSlaHours(obligation.deadline_rule, ctx.referenceDate),
    system_touchpoint: deriveSystemTouchpoint(obligation),
    risk_score: riskScore
  };
}

/** FR-10: derives task_name/owner_role/sla_hours/system_touchpoint (never
 *  free-text generation) plus risk_score, WITHOUT setting task_id,
 *  valid_from, valid_to, or recorded_at — those are the Orchestrator's
 *  responsibility at actual graph-write time (Spec 01/08). */
export async function mapObligationToProcessTask(obligation: Obligation, ctx: MappingContext): Promise<ProcessTaskDraft> {
  validateObligation(obligation);
  const { riskScoreExplain } = await computeRiskScoringComponents(obligation, ctx);
  return buildProcessTaskDraft(obligation, ctx, riskScoreExplain.riskScore);
}

export interface MappingRiskScoringResult {
  processTaskDraft: ProcessTaskDraft;
  riskScoreExplain: RiskScoreExplain;
  /** FR-8: "low" when deadline_rule fell into a fallback branch (Types D/E,
   *  an unparseable Type C date, or an uncaptured/unparseable Type A/B/C
   *  numeric group) — surfaced here (not just computed internally) so
   *  Spec 07's audit ledger can show a reviewer "this SLA/deadline
   *  proximity was a low-confidence guess," per FR-8's explicit wording. */
  slaConfidence: "high" | "low";
  overwriteCheck: OverwriteCheckResult;
  firstSeenCheck: FirstSeenCheckResult;
}

// ---------------------------------------------------------------------------
// NFR-3: structured logging
// ---------------------------------------------------------------------------

/** Logs one structured JSON line to stdout, mirroring
 *  packages/graph-db/src/logger.ts's `logOperation` convention. Every
 *  derived intermediate value is included (NFR-3) so Spec 07's
 *  Hash-chained Audit Ledger — and a human reviewer reading it — can see
 *  *why* a risk_score/tier-relevant signal was produced, not just the
 *  final numbers. Never throws (logging must not break the mapping path). */
export function logMappingRiskScoringResult(obligationId: string, result: MappingRiskScoringResult): void {
  try {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        operation: "runMappingAndRiskScoring",
        obligation_id: obligationId,
        process_task_draft: result.processTaskDraft,
        risk_score_explain: result.riskScoreExplain,
        sla_confidence: result.slaConfidence,
        overwrite_check: result.overwriteCheck,
        first_seen_check: result.firstSeenCheck
      })
    );
  } catch {
    // Logging must never break the mapping/risk-scoring path.
  }
}

/** The top-level entry point the Orchestrator (Spec 08) actually calls.
 *  Pure function of (obligation, ctx.referenceDate, current graph state)
 *  per FR-2/NFR-6 — deterministic, no LLM call (FR-3), no graph writes
 *  (NFR-7). Does NOT call `routeTier` itself: the Orchestrator combines
 *  this result's `riskScoreExplain.riskScore` and
 *  `firstSeenCheck.isFirstSeenObligationType` with Spec 04's separate
 *  `hasContradiction` output and the Obligation's own
 *  confidence_score/grounding_score to build the `TierRouteInput` that
 *  `routeTier` (../scorers/risk-score.scorer.ts) consumes. */
export async function runMappingAndRiskScoring(obligation: Obligation, ctx: MappingContext): Promise<MappingRiskScoringResult> {
  validateObligation(obligation);

  const { overwriteCheck, firstSeenCheck, riskScoreExplain, slaConfidence } = await computeRiskScoringComponents(obligation, ctx);
  const processTaskDraft = buildProcessTaskDraft(obligation, ctx, riskScoreExplain.riskScore);

  const result: MappingRiskScoringResult = { processTaskDraft, riskScoreExplain, slaConfidence, overwriteCheck, firstSeenCheck };
  logMappingRiskScoringResult(obligation.obligation_id, result);
  return result;
}

// ---------------------------------------------------------------------------
// Agent export (Task 11) — same { name, description } shape Spec 08's
// fan-out array already expects, now with a `run` method.
// ---------------------------------------------------------------------------

export const mappingRiskScoringAgent = {
  name: "mapping-and-risk-scoring",
  description: "Deterministically maps an Obligation to a ProcessTask and computes its risk_score.",
  run: runMappingAndRiskScoring
};
