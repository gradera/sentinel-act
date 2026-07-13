// Local data-contract module for the Change and Delta Agent (Spec 06 §4).
// Every type here is specific to this unit's *proposal* contract — none of
// it is persisted and none of it belongs in `@sentinel-act/graph-schema`.
// Schema node types (Circular/Clause/Obligation/ProcessTask) are reused
// verbatim; upstream agent types (Spec 02/03/05) are imported, never
// redefined.
//
// NOTE (spec import-path correction): Spec 06 §4 lists
// `MappingRiskScoringResult` as importable from
// `../scorers/risk-score.scorer.js`, but that type is actually defined
// (and only exported) from `./mapping-risk-scoring.agent.js`
// (`ProcessTaskDraft`/`RiskScoreExplain` do live in the scorer). We import
// each from where it truly lives; the contract shapes are identical to
// what the spec describes.
import type { Circular, Clause, Obligation, ProcessTask } from "@sentinel-act/graph-schema";
import type { AmendmentContext, ClauseCandidate, RegulatoryWatchTriggerEvent } from "./regulatory-watch.types.js";
import type { ObligationProposal, ObligationExtractionOutput } from "./obligation-extraction.agent.js";
import type { ProcessTaskDraft, RiskScoreExplain } from "../scorers/risk-score.scorer.js";
import type { MappingRiskScoringResult } from "./mapping-risk-scoring.agent.js";

export type { ProcessTaskDraft, RiskScoreExplain, MappingRiskScoringResult };

// ============================================================
// Agent input (assembled by the Orchestrator, §5.2)
// ============================================================

/** Everything this unit needs for one amendment-processing run. New,
 *  non-schema type — describes a call shape, not a persisted fact. */
export interface ChangeAndDeltaInput {
  triggerEvent: RegulatoryWatchTriggerEvent; // Spec 02 output that started this run
  /** One entry per ClauseCandidate belonging to the new/amended circular
   *  that the Orchestrator has already run through Extraction, Verification,
   *  and Mapping/Risk-Scoring. Order matches triggerEvent.clauses. */
  upstreamResults: UpstreamClauseResult[];
  /** ISO date, "now" for this run — always passed explicitly (never
   *  Date.now() inside pure helpers), matching the determinism convention
   *  Spec 05 already established. */
  referenceDate: string;
}

/** New, non-schema type. Bundles one ClauseCandidate's full upstream
 *  pipeline output for this unit to consume without re-deriving it. */
export interface UpstreamClauseResult {
  clauseCandidate: ClauseCandidate; // Spec 02
  extraction: ObligationExtractionOutput; // Spec 03
  /** One entry per extraction.proposals[i], same order/index. When
   *  contradictionFlags[i] is true, mappingResults[i] is null (Spec 05 is
   *  never invoked for a contradictory proposal — see §6 FR-2). */
  mappingResults: Array<MappingRiskScoringResult | null>;
  /** contradictionFlags[i] corresponds to extraction.proposals[i]; when
   *  true, this unit MUST exclude proposals[i] from the diff entirely. */
  contradictionFlags: boolean[];
}

// ============================================================
// Graph read port (this unit's only interaction with Neo4j)
// ============================================================

/** New, non-schema type — the narrowest read-only interface this unit
 *  depends on, satisfied by Spec 01's repositories, so this unit is
 *  unit-testable against a fake. Mirrors the GraphQueryPort pattern
 *  Spec 05 already established. Read-only, always (NFR-8). */
export interface ChangeAndDeltaGraphPort {
  /** All Obligations with valid_to IS NULL, DERIVED_FROM a Clause
   *  PART_OF the given Circular — the pre-amendment snapshot. */
  getLiveObligationsUnderCircular(circularId: string): Promise<Array<{ obligation: Obligation; clause: Clause }>>;

  /** A specific Clause of the target circular by its para_ref, or null if
   *  no such paragraph currently exists (relevant for "newly added"). */
  getClauseByParaRef(circularId: string, paraRef: string): Promise<Clause | null>;

  /** All Clauses currently PART_OF the given Circular, used for the
   *  full-document supersession path (§6 FR-16..FR-19). */
  getAllClausesUnderCircular(circularId: string): Promise<Clause[]>;

  /** The currently-live ProcessTask MAPPED_TO the given Obligation, or
   *  null if none exists yet (should not normally happen for a
   *  `committed` Obligation, but must not throw if it does — see §8). */
  getLiveProcessTaskForObligation(obligationId: string): Promise<ProcessTask | null>;

  getCircular(circularId: string): Promise<Circular | null>;
}

// ============================================================
// Paragraph alignment (the one LLM sub-step, §6 / §5.4)
// ============================================================

export type AlignmentMethod =
  | "single_paragraph_direct" // 1 amendedParaRef, 1 new Clause, marker-stripped deterministically
  | "marker_regex_split" // >1 amendedParaRef, deterministic marker-boundary split succeeded
  | "llm_aligned" // deterministic paths failed or were ambiguous; LLM sub-step used
  | "unresolved"; // no method produced a confident mapping

export interface ClauseTextDiff {
  paraRef: string; // the OLD circular's para_ref being evaluated
  oldClause: Clause | null; // null only for a "newly added" paragraph
  newText: string | null; // the substituted/added text; null for a repeal
  similarity: number; // 0..1, computeClauseSimilarity() output; 1.0 if newText is null (n/a)
  alignmentMethod: AlignmentMethod;
  alignmentConfidence: number; // 0..1; 1.0 for single_paragraph_direct
  materiality: "unchanged" | "material"; // similarity threshold classification, §6
}

/** New, non-schema port. This is the ONLY place in this unit that calls a
 *  model. Scoped to text-span alignment only — never "does this matter" or
 *  "what changed," only "which of these candidate old paragraphs does this
 *  span of new text replace, if any." */
export interface ParagraphAlignmentPort {
  alignParagraphs(input: ParagraphAlignmentInput): Promise<ParagraphAlignmentResult[]>;
}

export interface ParagraphAlignmentInput {
  amendmentText: string; // the full new Clause's text
  candidateOldParagraphs: Array<{ paraRef: string; text: string }>;
}

export interface ParagraphAlignmentResult {
  paraRef: string;
  matchedText: string | null; // the substituted text for this para_ref, or null if not addressed
  confidence: number; // 0..1, model-reported, NOT trusted as final — see FR-13
}

// ============================================================
// Obligation-level classification
// ============================================================

export type ObligationDiffAction = "superseded" | "newly_added" | "repealed" | "unaffected";

/** New, non-schema type. One entry per candidate para_ref examined — the
 *  full audit trail, including "unaffected" entries, so a reviewer can see
 *  the complete scope of what this unit checked, not just what it flagged. */
export interface ObligationDiffEntry {
  action: ObligationDiffAction;
  clauseDiff: ClauseTextDiff;
  oldObligation: Obligation | null; // set for superseded/repealed/unaffected
  newObligationProposal: ObligationProposal | null; // set for superseded/newly_added
  newObligationMapping: MappingRiskScoringResult | null; // set for superseded/newly_added
  rationale: string; // human-readable justification, always non-empty
}

// ============================================================
// ProcessTask redline (the artifact the console renders)
// ============================================================

export type FieldDiffStatus = "unchanged" | "changed" | "added" | "removed";

export interface ProcessTaskFieldDiff {
  field: "task_name" | "owner_role" | "sla_hours" | "system_touchpoint" | "risk_score";
  oldValue: string | number | null;
  newValue: string | number | null;
  status: FieldDiffStatus;
}

export interface ProcessTaskRedline {
  /** null when there is no prior ProcessTask to diff against (newly_added
   *  action, or a superseded Obligation that — unexpectedly — had no live
   *  ProcessTask, see §8). */
  oldTaskId: string | null;
  oldObligationId: string | null;
  newProcessTaskDraft: ProcessTaskDraft;
  newObligationProposal: ObligationProposal;
  fields: ProcessTaskFieldDiff[]; // always exactly 5 entries, one per ProcessTask field
  overallStatus: "new" | "modified";
}

// ============================================================
// Unresolved alignment (forces escalation upstream, §6/§8)
// ============================================================

export interface UnresolvedAlignment {
  paraRef: string;
  reason: "no_confident_deterministic_split" | "llm_confidence_below_threshold" | "old_clause_not_found";
  attemptedMethod: AlignmentMethod;
  confidence: number;
}

// ============================================================
// Circular-level supersession (full-document path only)
// ============================================================

export interface CircularSupersessionInstruction {
  oldCircularId: string;
  newCircularId: string;
  effectiveDate: string;
}

// ============================================================
// Output contract to the Orchestrator
// ============================================================

export interface ObligationSupersession {
  oldObligationId: string;
  newObligationProposal: ObligationProposal;
  newObligationDerivedFromClauseId: string;
  newObligationMapping: MappingRiskScoringResult;
  effectiveDate: string;
  redline: ProcessTaskRedline;
}

export interface ObligationAddition {
  newObligationProposal: ObligationProposal;
  newObligationDerivedFromClauseId: string;
  newObligationMapping: MappingRiskScoringResult;
  redline: ProcessTaskRedline; // oldTaskId: null, overallStatus: "new"
}

export interface ObligationRepeal {
  oldObligationId: string;
  effectiveDate: string;
  reason: string; // e.g. "Paragraph 46(c) removed by amendment; no replacement provision"
}

/** The unit's sole output. New, non-schema type — the Orchestrator
 *  translates this into a Spec 01 CommitPlan (§5.4) after tier routing. */
export interface ChangeProposal {
  changeProposalId: string; // uuid v4
  triggerEventId: string; // correlates to RegulatoryWatchTriggerEvent.eventId
  amendmentContext: AmendmentContext;
  scope: "paragraph_amendment" | "full_document_supersession";
  targetCircularId: string;
  effectiveDate: string; // ISO date; the amendment/new circular's date_effective

  supersessions: ObligationSupersession[];
  additions: ObligationAddition[];
  repeals: ObligationRepeal[];
  circularSupersession: CircularSupersessionInstruction | null; // full-document path only, else null

  redlines: ProcessTaskRedline[]; // == supersessions[].redline ++ additions[].redline, flattened for the console
  diffEntries: ObligationDiffEntry[]; // full audit trail, including "unaffected"
  unresolvedAlignments: UnresolvedAlignment[]; // non-empty forces escalation, §6/§8

  overallConfidence: number; // min() across amendmentContext.confidence, every alignmentConfidence used, and every consumed proposal's confidence_score
  usedLlmAlignment: boolean;
  generatedAt: string; // ISO datetime
}

export type ChangeAndDeltaScope = "paragraph_amendment" | "full_document_supersession";
