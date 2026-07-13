// Change and Delta Agent (Spec 06) — the flagship differentiator.
// Triggered by the Watch agent on a new or amended circular. Computes a
// structural graph diff between the pre- and post-amendment snapshot
// (which live Obligations are superseded / newly added / repealed /
// unaffected) and drafts the redlined ProcessTask update shown in the
// reviewer's detail view.
//
// DETERMINISTIC for the structural diff itself (bitemporal graph reads +
// mechanical token-similarity comparison); the one narrow LLM sub-step
// (paragraph text-span alignment, change-and-delta.alignment.ts) is scoped
// to matching text to paragraph numbers, never judging materiality or tier.
// Proposes only — never writes to Neo4j (NFR-8).
import { computeChangeProposal } from "./change-and-delta.core.js";

export const changeAndDeltaAgent = {
  name: "change-and-delta",
  description:
    "Computes a structural graph diff across a circular amendment and " +
    "drafts the redlined ProcessTask update. Deterministic except for a " +
    "narrowly-scoped paragraph-alignment LLM sub-step (see spec §6).",
  run: computeChangeProposal
};

// Re-export the unit's public surface so callers (Spec 08 orchestrator,
// tests, live wiring) import from one agent entry point.
export {
  computeChangeProposal,
  resolveScope,
  resolveClausePairs,
  computeClauseSimilarity,
  classifyObligationDiffs,
  buildProcessTaskRedline,
  assembleChangeProposal,
  logChangeProposal,
  CLAUSE_SIMILARITY_UNCHANGED_THRESHOLD,
  LLM_ALIGNMENT_CONFIDENCE_THRESHOLD,
  SINGLE_PARAGRAPH_DIRECT_CONFIDENCE,
  MARKER_SPLIT_CONFIDENCE,
  FULL_DOC_DIRECT_MATCH_CONFIDENCE,
  CHANGE_AND_DELTA_PROCESS_TASK_FIELDS
} from "./change-and-delta.core.js";
export type { AssembleOptions } from "./change-and-delta.core.js";

export {
  createDefaultParagraphAlignmentPort,
  paragraphAlignmentResultSchema,
  paragraphAlignmentResponseSchema,
  changeAndDeltaAlignmentAgent,
  ALIGNMENT_AGENT_VERSION,
  MAX_ALIGNMENT_BATCH_SIZE,
  CHANGE_AND_DELTA_ALIGNMENT_SYSTEM_PROMPT
} from "./change-and-delta.alignment.js";

export { createChangeAndDeltaGraphPortFromDriver } from "./change-and-delta.graph.js";
export type { Neo4jDriverLike } from "./change-and-delta.graph.js";

export { stripAmendmentPreamble, markerSplit, AMENDMENT_PREAMBLE_MARKER } from "./change-and-delta.markers.js";

export { ChangeAndDeltaNotApplicableError, ChangeAndDeltaStaleTargetError } from "./change-and-delta.errors.js";

export type {
  ChangeAndDeltaInput,
  ChangeAndDeltaGraphPort,
  ChangeAndDeltaScope,
  ChangeProposal,
  ClauseTextDiff,
  AlignmentMethod,
  ObligationDiffAction,
  ObligationDiffEntry,
  ObligationSupersession,
  ObligationAddition,
  ObligationRepeal,
  ProcessTaskRedline,
  ProcessTaskFieldDiff,
  FieldDiffStatus,
  UnresolvedAlignment,
  CircularSupersessionInstruction,
  UpstreamClauseResult,
  ParagraphAlignmentPort,
  ParagraphAlignmentInput,
  ParagraphAlignmentResult
} from "./change-and-delta.types.js";
