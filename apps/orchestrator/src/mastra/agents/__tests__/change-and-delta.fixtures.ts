// Shared test fixtures for the Change and Delta Agent (Spec 06 §10 / §13
// task 13). Includes an in-memory fake ChangeAndDeltaGraphPort, a mockable
// ParagraphAlignmentPort, and the flagship CUSPA / Paragraph 46 pre/post
// data (readable ids matching the spec's §6 worked example, structurally
// identical to Spec 01's `cuspa-pre` seed fixture).
import type { Circular, Clause, Obligation, ProcessTask } from "@sentinel-act/graph-schema";
import type {
  CircularCandidate,
  ClauseCandidate,
  AmendmentContext,
  RegulatoryWatchTriggerEvent
} from "../regulatory-watch.types.js";
import type { ObligationExtractionOutput, ObligationProposal } from "../obligation-extraction.agent.js";
import type { MappingRiskScoringResult } from "../mapping-risk-scoring.agent.js";
import type {
  ChangeAndDeltaGraphPort,
  ParagraphAlignmentInput,
  ParagraphAlignmentPort,
  ParagraphAlignmentResult,
  UpstreamClauseResult
} from "../change-and-delta.types.js";

const RECORDED_AT = "2026-07-13T00:00:00.000Z";

// ---------------------------------------------------------------------------
// CUSPA / Paragraph 46 — pre-amendment graph state (§6 worked example)
// ---------------------------------------------------------------------------

export const OLD_CIRCULAR_ID = "circ-masterbroker-2024";
export const OLD_CLAUSE_46_ID = "clause-46-orig";
export const OLD_OBLIGATION_ID = "obl-cuspa-old";
export const OLD_TASK_ID = "task-cuspa-old";

export const OLD_46_TEXT =
  "46. A stock broker shall maintain unpaid securities of a client in a separate Client Unpaid Securities Account " +
  "and shall not deal with, pledge, or otherwise encumber such securities without the express written instruction " +
  "of the client for each instance.";

export function oldMasterCircular(overrides: Partial<Circular> = {}): Circular {
  return {
    circular_id: OLD_CIRCULAR_ID,
    title: "Master Circular for Stock Brokers",
    type: "master_circular",
    category: "Stockbroker",
    date_issued: "2024-03-20",
    date_effective: "2024-04-01",
    source_hash: "old-hash",
    supersedes_circular_id: null,
    valid_from: "2024-04-01",
    valid_to: null,
    recorded_at: RECORDED_AT,
    ...overrides
  };
}

export function oldClause46(overrides: Partial<Clause> = {}): Clause {
  return {
    clause_id: OLD_CLAUSE_46_ID,
    circular_id: OLD_CIRCULAR_ID,
    para_ref: "46",
    text: OLD_46_TEXT,
    embedding_ref: "",
    valid_from: "2024-04-01",
    valid_to: null,
    recorded_at: RECORDED_AT,
    ...overrides
  };
}

export function oldObligation(overrides: Partial<Obligation> = {}): Obligation {
  return {
    obligation_id: OLD_OBLIGATION_ID,
    derived_from_clause_id: OLD_CLAUSE_46_ID,
    category: "risk_management",
    requirement_text:
      "Maintain client unpaid securities in a segregated account and obtain express written client instruction before any pledge.",
    trigger_event: "client fails to make full pay-in by settlement date",
    deadline_rule: "NONE",
    responsible_role: "Stockbroker",
    evidence_required: "signed client instruction per pledge instance",
    penalty_ref: "Section 15HB, SEBI Act, 1992",
    confidence_score: 0.95,
    grounding_score: 0.95,
    status: "committed",
    valid_from: "2024-04-01",
    valid_to: null,
    recorded_at: RECORDED_AT,
    ...overrides
  };
}

export function oldTask(overrides: Partial<ProcessTask> = {}): ProcessTask {
  return {
    task_id: OLD_TASK_ID,
    obligation_id: OLD_OBLIGATION_ID,
    task_name: "risk_management — Maintain client unpaid securities in a segregated account…",
    owner_role: "Compliance Officer",
    sla_hours: 0,
    system_touchpoint: "Risk & Margin System",
    risk_score: 0.3,
    valid_from: "2024-04-01",
    valid_to: null,
    recorded_at: RECORDED_AT,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Amendment trigger event + upstream pipeline output (§6 worked example)
// ---------------------------------------------------------------------------

export const AMEND_CIRCULAR_ID = "circ-cuspa-amend-2026";
export const AMEND_CLAUSE_ID = "clause-cuspa-amend-1";

export const CUSPA_AMENDMENT_CLAUSE_TEXT =
  "In partial modification of Paragraph 46 of the Master Circular for Stock Brokers dated 1 April 2024, " +
  "Paragraph 46 is amended to read as follows: '46. A stock broker may automatically pledge a client's " +
  "unpaid securities to the extent of the client's outstanding debit, subject to the client's standing consent " +
  "captured through e-DIS/API authorization at account opening, and shall notify the client of each such " +
  "auto-pledge within 24 hours.'";

export function amendmentCircularCandidate(overrides: Partial<CircularCandidate> = {}): CircularCandidate {
  return {
    circular_id: AMEND_CIRCULAR_ID,
    title: "Amendment to Paragraph 46 of Master Circular for Stock Brokers — Client Unpaid Securities Auto-Pledge",
    type: "amendment",
    category: "Stockbroker",
    date_issued: "2026-07-01",
    date_effective: "2026-07-03",
    source_hash: "amend-hash",
    supersedes_circular_id: null,
    valid_from: "2026-07-03",
    valid_to: null,
    recorded_at: null,
    ...overrides
  };
}

export function clauseCandidate(
  clauseId: string,
  circularId: string,
  paraRef: string,
  text: string,
  overrides: Partial<ClauseCandidate> = {}
): ClauseCandidate {
  return {
    clause_id: clauseId,
    circular_id: circularId,
    para_ref: paraRef,
    text,
    valid_from: "2026-07-03",
    valid_to: null,
    recorded_at: null,
    embedding_ref: "",
    ...overrides
  };
}

export function amendmentContext(overrides: Partial<AmendmentContext> = {}): AmendmentContext {
  return {
    targetCircularId: OLD_CIRCULAR_ID,
    targetMatchedOnTitle: "Master Circular for Stock Brokers",
    amendedParaRefs: ["46"],
    confidence: 0.9,
    ...overrides
  };
}

export function triggerEvent(overrides: Partial<RegulatoryWatchTriggerEvent> = {}): RegulatoryWatchTriggerEvent {
  return {
    eventId: "evt-cuspa-001",
    pollRunId: "poll-001",
    emittedAt: "2026-07-03T09:00:00.000Z",
    changeType: "new",
    circular: amendmentCircularCandidate(),
    clauses: [clauseCandidate(AMEND_CLAUSE_ID, AMEND_CIRCULAR_ID, "1", CUSPA_AMENDMENT_CLAUSE_TEXT)],
    amendmentContext: amendmentContext(),
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Proposal / mapping builders
// ---------------------------------------------------------------------------

export function proposal(overrides: Partial<ObligationProposal> = {}): ObligationProposal {
  return {
    category: "risk_management",
    requirement_text:
      "A stock broker may auto-pledge a client's unpaid securities to the extent of the client's outstanding debit, " +
      "subject to standing e-DIS/API consent.",
    trigger_event: "client has an outstanding debit for unpaid securities and has provided standing e-DIS/API consent",
    deadline_rule: "T+24 hours to notify client of each auto-pledge",
    responsible_role: "Stockbroker",
    evidence_required: "auto-pledge notification log per instance",
    penalty_ref: "Section 15HB, SEBI Act, 1992",
    applies_to_category_names: ["Stockbroker"],
    applies_to_unknown_category_names: [],
    derived_from_clause_id: AMEND_CLAUSE_ID,
    confidence_score: 0.88,
    confidence_breakdown: {
      model_self_reported: 0.9,
      field_completeness_penalty: 0.02,
      ambiguity_penalty: 0,
      graphrag_support_bonus: 0,
      final: 0.88
    },
    extraction_index: 0,
    ...overrides
  };
}

export function extraction(
  proposals: ObligationProposal[],
  clauseId = AMEND_CLAUSE_ID,
  circularId = AMEND_CIRCULAR_ID,
  overrides: Partial<ObligationExtractionOutput> = {}
): ObligationExtractionOutput {
  return {
    clause_id: clauseId,
    circular_id: circularId,
    proposals,
    informational_only: proposals.length === 0,
    informational_reason: proposals.length === 0 ? "no obligation in amendment text" : null,
    graphrag_context: { similar_clauses: [], related_obligations: [], is_first_seen_obligation_type: false },
    agent_version: "obligation-extraction@test",
    model_id: "test-model",
    ...overrides
  };
}

export function mapping(draftOverrides: Partial<MappingRiskScoringResult["processTaskDraft"]> = {}): MappingRiskScoringResult {
  const processTaskDraft = {
    obligation_id: "obl-new-cuspa",
    task_name: "risk_management — A stock broker may auto-pledge a client's unpaid securities…",
    owner_role: "Compliance Officer",
    sla_hours: 24,
    system_touchpoint: "Risk & Margin System",
    risk_score: 0.84,
    ...draftOverrides
  };
  return {
    processTaskDraft,
    riskScoreExplain: {
      penaltySeverity: 0.5,
      deadlineProximityDays: 1,
      overwritesLiveObligation: true,
      riskScore: processTaskDraft.risk_score,
      deadlineWeight: 0.29,
      overwriteWeight: 0.3
    },
    slaConfidence: "high",
    overwriteCheck: { overwritesLiveObligation: true, matchPath: "heuristic", overwrittenObligationId: OLD_OBLIGATION_ID, degraded: false },
    firstSeenCheck: { isFirstSeenObligationType: false, degraded: false }
  };
}

export function upstreamResult(overrides: Partial<UpstreamClauseResult> = {}): UpstreamClauseResult {
  const p = proposal();
  return {
    clauseCandidate: clauseCandidate(AMEND_CLAUSE_ID, AMEND_CIRCULAR_ID, "1", CUSPA_AMENDMENT_CLAUSE_TEXT),
    extraction: extraction([p]),
    mappingResults: [mapping()],
    contradictionFlags: [false],
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Fake ChangeAndDeltaGraphPort (in-memory)
// ---------------------------------------------------------------------------

export interface FakeGraphData {
  circulars?: Circular[];
  clauses?: Clause[];
  obligations?: Obligation[];
  tasks?: ProcessTask[];
}

export function makeFakeGraph(data: FakeGraphData): ChangeAndDeltaGraphPort {
  const circulars = data.circulars ?? [];
  const clauses = data.clauses ?? [];
  const obligations = data.obligations ?? [];
  const tasks = data.tasks ?? [];
  const clauseById = new Map(clauses.map((c) => [c.clause_id, c]));

  return {
    async getLiveObligationsUnderCircular(circularId: string) {
      const out: Array<{ obligation: Obligation; clause: Clause }> = [];
      for (const o of obligations) {
        if (o.valid_to !== null) {
          continue;
        }
        const clause = clauseById.get(o.derived_from_clause_id);
        if (clause && clause.circular_id === circularId) {
          out.push({ obligation: o, clause });
        }
      }
      return out;
    },
    async getClauseByParaRef(circularId: string, paraRef: string) {
      return clauses.find((c) => c.circular_id === circularId && c.para_ref === paraRef) ?? null;
    },
    async getAllClausesUnderCircular(circularId: string) {
      return clauses.filter((c) => c.circular_id === circularId);
    },
    async getLiveProcessTaskForObligation(obligationId: string) {
      return tasks.find((t) => t.obligation_id === obligationId && t.valid_to === null) ?? null;
    },
    async getCircular(circularId: string) {
      return circulars.find((c) => c.circular_id === circularId) ?? null;
    }
  };
}

/** Default CUSPA graph: master circular live, para 46 clause + obligation +
 *  task seeded. */
export function makeCuspaGraph(overrides: FakeGraphData = {}): ChangeAndDeltaGraphPort {
  return makeFakeGraph({
    circulars: [oldMasterCircular()],
    clauses: [oldClause46()],
    obligations: [oldObligation()],
    tasks: [oldTask()],
    ...overrides
  });
}

// ---------------------------------------------------------------------------
// Mockable ParagraphAlignmentPort
// ---------------------------------------------------------------------------

/** Build a fake alignment port from a per-paraRef result map. `calls`
 *  records every invocation so tests can assert it was / was not used. */
export function makeAlignPort(
  results: Record<string, { matchedText: string | null; confidence: number }>,
  opts: { throwError?: boolean } = {}
): ParagraphAlignmentPort & { calls: ParagraphAlignmentInput[] } {
  const calls: ParagraphAlignmentInput[] = [];
  return {
    calls,
    async alignParagraphs(input: ParagraphAlignmentInput): Promise<ParagraphAlignmentResult[]> {
      calls.push(input);
      if (opts.throwError) {
        throw new Error("simulated alignment provider failure");
      }
      return input.candidateOldParagraphs.map((c) => ({
        paraRef: c.paraRef,
        matchedText: results[c.paraRef]?.matchedText ?? null,
        confidence: results[c.paraRef]?.confidence ?? 0
      }));
    }
  };
}

/** A port that must never be called (deterministic path assertion). */
export function neverCalledAlignPort(): ParagraphAlignmentPort & { calls: ParagraphAlignmentInput[] } {
  const calls: ParagraphAlignmentInput[] = [];
  return {
    calls,
    async alignParagraphs(input: ParagraphAlignmentInput): Promise<ParagraphAlignmentResult[]> {
      calls.push(input);
      throw new Error("alignment port should not have been called on the deterministic path");
    }
  };
}
