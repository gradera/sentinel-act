// Change and Delta Agent — deterministic structural graph diff (Spec 06).
//
// This unit is DETERMINISTIC for the structural diff itself: which
// Obligations are superseded/added/repealed/unaffected is decided by
// bitemporal graph reads and mechanical token-similarity comparison, never
// an LLM's opinion. The one narrow LLM sub-step (paragraph alignment) lives
// in change-and-delta.alignment.ts and is scoped to text-span matching only.
//
// Like every fanned-out agent this unit only ever PROPOSES; it never writes
// to Neo4j (NFR-8). There is no CREATE/MERGE/SET/DELETE Cypher and no
// write-session anywhere in this unit's files — grep-verifiable per the
// Definition of Done.
import { randomUUID } from "node:crypto";
import type { Circular, Clause, Obligation, ProcessTask } from "@sentinel-act/graph-schema";
import type { AmendmentContext, ClauseCandidate, RegulatoryWatchTriggerEvent } from "./regulatory-watch.types.js";
import type { ObligationProposal } from "./obligation-extraction.agent.js";
import type {
  ChangeAndDeltaGraphPort,
  ChangeAndDeltaInput,
  ChangeAndDeltaScope,
  ChangeProposal,
  ClauseTextDiff,
  MappingRiskScoringResult,
  ObligationAddition,
  ObligationDiffEntry,
  ObligationRepeal,
  ObligationSupersession,
  ParagraphAlignmentPort,
  ParagraphAlignmentResult,
  ProcessTaskFieldDiff,
  ProcessTaskRedline,
  UnresolvedAlignment,
  UpstreamClauseResult
} from "./change-and-delta.types.js";
import { ChangeAndDeltaNotApplicableError, ChangeAndDeltaStaleTargetError } from "./change-and-delta.errors.js";
import { markerSplit, stripAmendmentPreamble } from "./change-and-delta.markers.js";
import { MAX_ALIGNMENT_BATCH_SIZE } from "./change-and-delta.alignment.js";

// ---------------------------------------------------------------------------
// Threshold constants (§13 — uncalibrated placeholders, named exports so
// they are a one-line change once the compliance team confirms them, and
// so every raw score can be logged against them, NFR-7).
// ---------------------------------------------------------------------------
export const CLAUSE_SIMILARITY_UNCHANGED_THRESHOLD = 0.98;
export const LLM_ALIGNMENT_CONFIDENCE_THRESHOLD = 0.6;
export const SINGLE_PARAGRAPH_DIRECT_CONFIDENCE = 0.95;
export const MARKER_SPLIT_CONFIDENCE = 0.95;
export const FULL_DOC_DIRECT_MATCH_CONFIDENCE = 1.0;
/** Minimum token similarity required to associate a ClauseTextDiff's
 *  newText with a source amendment clause (proposal lookup). Low bar — the
 *  substituted text is a subset of the amendment clause's own text. */
const SOURCE_MATCH_MIN_SIMILARITY = 0.1;

export const CHANGE_AND_DELTA_PROCESS_TASK_FIELDS: ReadonlyArray<ProcessTaskFieldDiff["field"]> = [
  "task_name",
  "owner_role",
  "sla_hours",
  "system_touchpoint",
  "risk_score"
];

// ===========================================================================
// FR-1 — scope resolution
// ===========================================================================

export function resolveScope(triggerEvent: RegulatoryWatchTriggerEvent): ChangeAndDeltaScope | "not_applicable" {
  const { changeType, amendmentContext, circular } = triggerEvent;

  // Paragraph-amendment path (§5.2 condition 1): changeType "new" with a
  // resolved target circular. (Spec 06 §13 follows Spec 02's FR text /
  // Acceptance Criterion 3 over its inline comment: amendmentContext IS
  // populated on changeType "new" for the CUSPA case.)
  if (changeType === "new" && amendmentContext && amendmentContext.targetCircularId) {
    return "paragraph_amendment";
  }

  // Full-document supersession path: changeType "amendment" implies
  // supersedes_circular_id is set on the CircularCandidate.
  if (changeType === "amendment" && circular.supersedes_circular_id) {
    return "full_document_supersession";
  }

  return "not_applicable";
}

// ===========================================================================
// FR-10 — deterministic token-level clause similarity (no model call)
// ===========================================================================

/** Lowercase, strip punctuation (Unicode-aware), whitespace-tokenize. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/** FR-10. Deterministic 0..1 Dice coefficient over whitespace-tokenized,
 *  lowercased, punctuation-stripped token multisets. Determinism: same two
 *  strings always produce the same score. Monotonicity: more shared tokens
 *  never decreases the score. Identical text -> 1.0; disjoint token sets ->
 *  0. (Deliberately hand-rolled rather than adding the `diff` npm package
 *  as a new orchestrator dependency — see the final report; `diff` is only
 *  a dependency of packages/ui today, not apps/orchestrator.) */
export function computeClauseSimilarity(oldText: string, newText: string): number {
  const a = tokenize(oldText);
  const b = tokenize(newText);
  if (a.length === 0 && b.length === 0) {
    return 1;
  }
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const counts = new Map<string, number>();
  for (const token of a) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  let intersection = 0;
  for (const token of b) {
    const remaining = counts.get(token);
    if (remaining && remaining > 0) {
      counts.set(token, remaining - 1);
      intersection += 1;
    }
  }
  return (2 * intersection) / (a.length + b.length);
}

// ===========================================================================
// Clause pairing (FR-5..FR-9 paragraph path, FR-16..FR-19 full-doc path)
// ===========================================================================

interface RefResolution {
  paraRef: string;
  oldClause: Clause | null;
  newText: string | null;
  method: ClauseTextDiff["alignmentMethod"];
  confidence: number;
  unresolvedReason?: UnresolvedAlignment["reason"];
}

interface ClausePairingResult {
  clauseDiffs: ClauseTextDiff[];
  unresolvedAlignments: UnresolvedAlignment[];
  usedLlmAlignment: boolean;
}

function materialityOf(similarity: number): ClauseTextDiff["materiality"] {
  return similarity >= CLAUSE_SIMILARITY_UNCHANGED_THRESHOLD ? "unchanged" : "material";
}

function resolutionToDiff(res: RefResolution): ClauseTextDiff {
  let similarity: number;
  let materiality: ClauseTextDiff["materiality"];

  if (res.newText === null) {
    // "unaffected" (amendment didn't address — FR-9) or an "unresolved"
    // alignment. Confirmed repeals (full-doc FR-19) do NOT flow through here
    // — they are built directly via repealDiff(). An unaddressed paragraph
    // is "unchanged" (similarity n/a = 1.0); an unresolved one is flagged
    // material so it is never silently treated as a cosmetic no-op.
    if (res.method === "unresolved") {
      similarity = 0;
      materiality = "material";
    } else {
      similarity = 1;
      materiality = "unchanged";
    }
  } else if (res.oldClause === null) {
    // Newly added — no prior text to compare against.
    similarity = 0;
    materiality = "material";
  } else {
    similarity = computeClauseSimilarity(res.oldClause.text, res.newText);
    materiality = materialityOf(similarity);
  }

  return {
    paraRef: res.paraRef,
    oldClause: res.oldClause,
    newText: res.newText,
    similarity,
    alignmentMethod: res.method,
    alignmentConfidence: res.confidence,
    materiality
  };
}

/** FR-19 confirmed-repeal ClauseTextDiff: newText null + materiality
 *  "material" is the encoding classify reads as "confirmed removal",
 *  distinct from the FR-9 "amendment didn't address this paragraph" case
 *  (newText null + materiality "unchanged"). */
function repealDiff(paraRef: string, oldClause: Clause): ClauseTextDiff {
  return {
    paraRef,
    oldClause,
    newText: null,
    similarity: 0,
    alignmentMethod: "single_paragraph_direct",
    alignmentConfidence: FULL_DOC_DIRECT_MATCH_CONFIDENCE,
    materiality: "material"
  };
}

// --------------------- paragraph-amendment pairing -------------------------

async function pairParagraphAmendment(
  amendmentContext: AmendmentContext,
  newClauses: ClauseCandidate[],
  targetCircularId: string,
  graph: ChangeAndDeltaGraphPort,
  align: ParagraphAlignmentPort
): Promise<ClausePairingResult> {
  const refs = amendmentContext.amendedParaRefs;
  const concatenated = newClauses.map((c) => c.text).join("\n");

  const oldClauseByRef = new Map<string, Clause | null>();
  for (const ref of refs) {
    oldClauseByRef.set(ref, await graph.getClauseByParaRef(targetCircularId, ref));
  }

  const resolutions = new Map<string, RefResolution>();
  let deterministicHandled = false;

  // FR-6 — single_paragraph_direct.
  if (refs.length === 1 && newClauses.length === 1) {
    const ref = refs[0];
    const stripped = stripAmendmentPreamble(newClauses[0].text);
    if (stripped !== null) {
      resolutions.set(ref, {
        paraRef: ref,
        oldClause: oldClauseByRef.get(ref) ?? null,
        newText: stripped,
        method: "single_paragraph_direct",
        confidence: SINGLE_PARAGRAPH_DIRECT_CONFIDENCE
      });
      deterministicHandled = true;
    }
  } else {
    // FR-7 — marker_regex_split.
    const split = markerSplit(concatenated, refs);
    if (split) {
      for (const ref of refs) {
        resolutions.set(ref, {
          paraRef: ref,
          oldClause: oldClauseByRef.get(ref) ?? null,
          newText: split.get(ref) ?? null,
          method: "marker_regex_split",
          confidence: MARKER_SPLIT_CONFIDENCE
        });
      }
      deterministicHandled = true;
    }
  }

  let usedLlmAlignment = false;

  // FR-8 — LLM alignment fallback for the refs the deterministic paths
  // could not isolate.
  if (!deterministicHandled) {
    const candidates = refs
      .map((ref) => ({ ref, old: oldClauseByRef.get(ref) ?? null }))
      .filter((c): c is { ref: string; old: Clause } => c.old !== null)
      .map((c) => ({ paraRef: c.ref, text: c.old.text }));

    let alignResults: ParagraphAlignmentResult[] = [];
    let llmFailed = false;
    if (candidates.length > 0) {
      try {
        alignResults = await align.alignParagraphs({ amendmentText: concatenated, candidateOldParagraphs: candidates });
      } catch {
        // FR-14/§8 — never throw for an alignment failure; degrade to
        // unresolved.
        llmFailed = true;
      }
    }
    const byRef = new Map(alignResults.map((r) => [r.paraRef, r]));

    for (const ref of refs) {
      const oldClause = oldClauseByRef.get(ref) ?? null;
      if (oldClause === null) {
        // A newly-added paragraph the deterministic paths could not isolate
        // — fail toward escalation (FR-14) rather than guess its text.
        resolutions.set(ref, {
          paraRef: ref,
          oldClause: null,
          newText: null,
          method: "unresolved",
          confidence: 0,
          unresolvedReason: "old_clause_not_found"
        });
        continue;
      }
      const res = byRef.get(ref);
      if (llmFailed || !res) {
        resolutions.set(ref, {
          paraRef: ref,
          oldClause,
          newText: null,
          method: "unresolved",
          confidence: 0,
          unresolvedReason: "no_confident_deterministic_split"
        });
        continue;
      }
      usedLlmAlignment = true;
      if (res.confidence < LLM_ALIGNMENT_CONFIDENCE_THRESHOLD) {
        // FR-13 — downgrade to unresolved, surface below-threshold reason.
        resolutions.set(ref, {
          paraRef: ref,
          oldClause,
          newText: res.matchedText,
          method: "unresolved",
          confidence: res.confidence,
          unresolvedReason: "llm_confidence_below_threshold"
        });
      } else {
        // FR-9 — matchedText null means "not addressed" -> unaffected.
        resolutions.set(ref, {
          paraRef: ref,
          oldClause,
          newText: res.matchedText,
          method: "llm_aligned",
          confidence: res.confidence
        });
      }
    }
  }

  const clauseDiffs: ClauseTextDiff[] = [];
  const unresolvedAlignments: UnresolvedAlignment[] = [];
  for (const ref of refs) {
    const res = resolutions.get(ref)!;
    const diff = resolutionToDiff(res);
    clauseDiffs.push(diff);
    if (res.method === "unresolved") {
      unresolvedAlignments.push({
        paraRef: ref,
        reason: res.unresolvedReason ?? "no_confident_deterministic_split",
        attemptedMethod: "unresolved",
        confidence: res.confidence
      });
    }
    if (res.method === "llm_aligned") {
      usedLlmAlignment = true;
    }
  }

  return { clauseDiffs, unresolvedAlignments, usedLlmAlignment };
}

// --------------------- full-document pairing (FR-16..FR-19) ----------------

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

async function pairFullDocument(
  oldCircularId: string,
  newClauses: ClauseCandidate[],
  graph: ChangeAndDeltaGraphPort,
  align: ParagraphAlignmentPort
): Promise<ClausePairingResult> {
  const oldClauses = await graph.getAllClausesUnderCircular(oldCircularId);
  const newByRef = new Map<string, ClauseCandidate>();
  for (const c of newClauses) {
    newByRef.set(c.para_ref, c);
  }

  const clauseDiffs: ClauseTextDiff[] = [];
  const unresolvedAlignments: UnresolvedAlignment[] = [];
  let usedLlmAlignment = false;

  const unmatchedOld: Clause[] = [];

  // FR-16 — direct para_ref-to-para_ref match first.
  for (const oldClause of oldClauses) {
    const newClause = newByRef.get(oldClause.para_ref);
    if (newClause) {
      clauseDiffs.push(
        resolutionToDiff({
          paraRef: oldClause.para_ref,
          oldClause,
          newText: newClause.text,
          method: "single_paragraph_direct",
          confidence: FULL_DOC_DIRECT_MATCH_CONFIDENCE
        })
      );
    } else {
      unmatchedOld.push(oldClause);
    }
  }

  // FR-17 — batched renumbering check for unmatched old paragraphs.
  const newFullText = newClauses.map((c) => c.text).join("\n");
  const confirmedRepeals: Clause[] = [];
  for (const batch of chunk(unmatchedOld, MAX_ALIGNMENT_BATCH_SIZE)) {
    let results: ParagraphAlignmentResult[] = [];
    let failed = false;
    try {
      results = await align.alignParagraphs({
        amendmentText: newFullText,
        candidateOldParagraphs: batch.map((c) => ({ paraRef: c.para_ref, text: c.text }))
      });
    } catch {
      failed = true;
    }
    const byRef = new Map(results.map((r) => [r.paraRef, r]));
    for (const oldClause of batch) {
      const res = byRef.get(oldClause.para_ref);
      if (failed || !res) {
        // Could not confirm removal — fail toward escalation, do NOT
        // falsely repeal.
        clauseDiffs.push(
          resolutionToDiff({
            paraRef: oldClause.para_ref,
            oldClause,
            newText: null,
            method: "unresolved",
            confidence: 0,
            unresolvedReason: "no_confident_deterministic_split"
          })
        );
        unresolvedAlignments.push({
          paraRef: oldClause.para_ref,
          reason: "no_confident_deterministic_split",
          attemptedMethod: "unresolved",
          confidence: 0
        });
        continue;
      }
      if (res.matchedText !== null && res.confidence >= LLM_ALIGNMENT_CONFIDENCE_THRESHOLD) {
        // Renumbered / retained (possibly changed) — treat as a normal diff.
        usedLlmAlignment = true;
        clauseDiffs.push(
          resolutionToDiff({
            paraRef: oldClause.para_ref,
            oldClause,
            newText: res.matchedText,
            method: "llm_aligned",
            confidence: res.confidence
          })
        );
      } else if (res.confidence < LLM_ALIGNMENT_CONFIDENCE_THRESHOLD && res.matchedText !== null) {
        // Ambiguous renumbering — escalate rather than repeal or supersede.
        clauseDiffs.push(
          resolutionToDiff({
            paraRef: oldClause.para_ref,
            oldClause,
            newText: res.matchedText,
            method: "unresolved",
            confidence: res.confidence,
            unresolvedReason: "llm_confidence_below_threshold"
          })
        );
        unresolvedAlignments.push({
          paraRef: oldClause.para_ref,
          reason: "llm_confidence_below_threshold",
          attemptedMethod: "unresolved",
          confidence: res.confidence
        });
      } else {
        // FR-19 — confirmed no corresponding new paragraph -> repeal.
        confirmedRepeals.push(oldClause);
      }
    }
  }

  for (const oldClause of confirmedRepeals) {
    clauseDiffs.push(repealDiff(oldClause.para_ref, oldClause));
  }

  // FR-18 — new paragraphs with no matching old paragraph -> newly_added.
  const oldRefs = new Set(oldClauses.map((c) => c.para_ref));
  const renumberedNewText = new Set(
    clauseDiffs.filter((d) => d.alignmentMethod === "llm_aligned" && d.newText !== null).map((d) => d.newText as string)
  );
  for (const newClause of newClauses) {
    if (oldRefs.has(newClause.para_ref)) {
      continue; // already handled by FR-16 direct match
    }
    if (renumberedNewText.has(newClause.text)) {
      continue; // this new text was matched to a renumbered old paragraph
    }
    clauseDiffs.push(
      resolutionToDiff({
        paraRef: newClause.para_ref,
        oldClause: null,
        newText: newClause.text,
        method: "single_paragraph_direct",
        confidence: FULL_DOC_DIRECT_MATCH_CONFIDENCE
      })
    );
  }

  return { clauseDiffs, unresolvedAlignments, usedLlmAlignment };
}

/** §5.3 public signature. Thin wrapper over the internal richer pairing so
 *  the exported surface matches the spec (returns ClauseTextDiff[] only).
 *  computeChangeProposal uses the richer form internally to also surface
 *  unresolvedAlignments. */
export async function resolveClausePairs(
  scope: ChangeAndDeltaScope,
  amendmentContext: AmendmentContext,
  newClauses: ClauseCandidate[],
  targetCircularId: string,
  graph: ChangeAndDeltaGraphPort,
  align: ParagraphAlignmentPort
): Promise<ClauseTextDiff[]> {
  const result =
    scope === "paragraph_amendment"
      ? await pairParagraphAmendment(amendmentContext, newClauses, targetCircularId, graph, align)
      : await pairFullDocument(targetCircularId, newClauses, graph, align);
  return result.clauseDiffs;
}

// ===========================================================================
// Proposal source lookup (associate a ClauseTextDiff's newText with the
// upstream extraction/mapping output that produced it, FR-2 exclusion aware)
// ===========================================================================

type SourceStatus = "found" | "informational_only" | "contradiction_excluded" | "not_found";

interface SourceProposalLookup {
  proposal: ObligationProposal | null;
  mapping: MappingRiskScoringResult | null;
  status: SourceStatus;
}

function findSourceUpstream(diff: ClauseTextDiff, upstreamResults: UpstreamClauseResult[]): UpstreamClauseResult | null {
  if (diff.newText === null) {
    return null;
  }
  // Prefer a direct para_ref match (full-document path: new clause keeps
  // its para_ref).
  const direct = upstreamResults.find((ur) => ur.clauseCandidate.para_ref === diff.paraRef);
  if (direct) {
    return direct;
  }
  // Otherwise pick the amendment clause whose text best matches the
  // substituted text (paragraph-amendment path: amendment clause para_ref
  // differs from the target para_ref).
  let best: UpstreamClauseResult | null = null;
  let bestScore = SOURCE_MATCH_MIN_SIMILARITY;
  for (const ur of upstreamResults) {
    const score = computeClauseSimilarity(diff.newText, ur.clauseCandidate.text);
    if (score >= bestScore) {
      bestScore = score;
      best = ur;
    }
  }
  return best;
}

function lookupSourceProposal(diff: ClauseTextDiff, upstreamResults: UpstreamClauseResult[]): SourceProposalLookup {
  const source = findSourceUpstream(diff, upstreamResults);
  if (!source) {
    return { proposal: null, mapping: null, status: "not_found" };
  }
  if (source.extraction.informational_only || source.extraction.proposals.length === 0) {
    return { proposal: null, mapping: null, status: "informational_only" };
  }
  for (let i = 0; i < source.extraction.proposals.length; i++) {
    const excluded = source.contradictionFlags[i] === true;
    const mapping = source.mappingResults[i] ?? null;
    if (!excluded && mapping) {
      return { proposal: source.extraction.proposals[i], mapping, status: "found" };
    }
  }
  // Every proposal on this clause was contradiction-excluded (FR-2 / AC6).
  return { proposal: null, mapping: null, status: "contradiction_excluded" };
}

// ===========================================================================
// FR-9..FR-12 / §8 — classifyObligationDiffs
// ===========================================================================

export function classifyObligationDiffs(
  clauseDiffs: ClauseTextDiff[],
  liveObligations: Array<{ obligation: Obligation; clause: Clause }>,
  upstreamResults: UpstreamClauseResult[]
): ObligationDiffEntry[] {
  const entries: ObligationDiffEntry[] = [];

  const liveByRef = new Map<string, Array<{ obligation: Obligation; clause: Clause }>>();
  for (const lo of liveObligations) {
    const arr = liveByRef.get(lo.clause.para_ref) ?? [];
    arr.push(lo);
    liveByRef.set(lo.clause.para_ref, arr);
  }

  for (const diff of clauseDiffs) {
    const matchingLive = liveByRef.get(diff.paraRef) ?? [];
    const firstOld = matchingLive[0]?.obligation ?? null;

    // Unresolved alignment — surfaced separately in unresolvedAlignments;
    // logged here so the audit trail shows the paragraph was checked. No
    // supersession is produced (AC4).
    if (diff.alignmentMethod === "unresolved") {
      entries.push({
        action: "unaffected",
        clauseDiff: diff,
        oldObligation: firstOld,
        newObligationProposal: null,
        newObligationMapping: null,
        rationale: `Alignment unresolved for paragraph ${diff.paraRef} (confidence ${diff.alignmentConfidence.toFixed(
          2
        )}); escalation forced upstream — no supersession produced.`
      });
      continue;
    }

    // Repeal (full-document FR-19): newText null + materiality material +
    // a live obligation exists.
    if (diff.newText === null && diff.materiality === "material" && matchingLive.length > 0) {
      for (const lo of matchingLive) {
        entries.push({
          action: "repealed",
          clauseDiff: diff,
          oldObligation: lo.obligation,
          newObligationProposal: null,
          newObligationMapping: null,
          rationale: `Paragraph ${diff.paraRef} removed by amendment with no replacement provision; obligation ${lo.obligation.obligation_id} repealed.`
        });
      }
      continue;
    }

    // Unaffected — amendment did not, in fact, change this paragraph
    // (FR-9 matchedText null, or FR-11/FR-12 cosmetic near-identical text).
    if (diff.newText === null || (diff.oldClause !== null && diff.materiality === "unchanged")) {
      const reason =
        diff.newText === null
          ? `Amendment did not substitute text for paragraph ${diff.paraRef}; obligation unaffected.`
          : `Paragraph ${diff.paraRef} text is near-identical (similarity ${diff.similarity.toFixed(
              3
            )} >= ${CLAUSE_SIMILARITY_UNCHANGED_THRESHOLD}); cosmetic republish, obligation unaffected.`;
      entries.push({
        action: "unaffected",
        clauseDiff: diff,
        oldObligation: firstOld,
        newObligationProposal: null,
        newObligationMapping: null,
        rationale: reason
      });
      continue;
    }

    // From here: a material substitution (oldClause may be null for a
    // newly-added paragraph). Associate the upstream proposal.
    const lookup = lookupSourceProposal(diff, upstreamResults);

    if (lookup.status === "contradiction_excluded") {
      // FR-2 / AC6 — excluded from supersessions/additions; still logged.
      entries.push({
        action: "unaffected",
        clauseDiff: diff,
        oldObligation: firstOld,
        newObligationProposal: null,
        newObligationMapping: null,
        rationale: `Paragraph ${diff.paraRef} changed materially but its extracted obligation was flagged contradictory upstream (Spec 04); excluded here and routed to ESCALATE independently.`
      });
      continue;
    }

    if (lookup.status !== "found" || !lookup.proposal || !lookup.mapping) {
      // No obligation to pair with. §8: a would-be superseded paragraph with
      // no proposal (informational-only deletion text) becomes a repeal; a
      // would-be newly_added paragraph with no proposal has nothing to add.
      if (matchingLive.length > 0) {
        for (const lo of matchingLive) {
          entries.push({
            action: "repealed",
            clauseDiff: diff,
            oldObligation: lo.obligation,
            newObligationProposal: null,
            newObligationMapping: null,
            rationale: `Paragraph ${diff.paraRef} amended with no extractable obligation (informational-only); obligation ${lo.obligation.obligation_id} repealed.`
          });
        }
      } else {
        entries.push({
          action: "unaffected",
          clauseDiff: diff,
          oldObligation: null,
          newObligationProposal: null,
          newObligationMapping: null,
          rationale: `New paragraph ${diff.paraRef} imposes no extractable obligation (informational-only); nothing to add.`
        });
      }
      continue;
    }

    // Material change with a usable new proposal.
    if (matchingLive.length > 0) {
      for (const lo of matchingLive) {
        entries.push({
          action: "superseded",
          clauseDiff: diff,
          oldObligation: lo.obligation,
          newObligationProposal: lookup.proposal,
          newObligationMapping: lookup.mapping,
          rationale: `Paragraph ${diff.paraRef} changed materially (similarity ${diff.similarity.toFixed(
            3
          )} < ${CLAUSE_SIMILARITY_UNCHANGED_THRESHOLD}); obligation ${lo.obligation.obligation_id} superseded.`
        });
      }
    } else {
      entries.push({
        action: "newly_added",
        clauseDiff: diff,
        oldObligation: null,
        newObligationProposal: lookup.proposal,
        newObligationMapping: lookup.mapping,
        rationale: `Paragraph ${diff.paraRef} has no prior counterpart obligation; newly added.`
      });
    }
  }

  return entries;
}

// ===========================================================================
// FR-21..FR-24 — buildProcessTaskRedline
// ===========================================================================

function fieldValue(task: ProcessTask | null, draft: MappingRiskScoringResult["processTaskDraft"], field: ProcessTaskFieldDiff["field"]): {
  oldValue: string | number | null;
  newValue: string | number | null;
} {
  const newValue = draft[field] as string | number;
  const oldValue = task ? (task[field] as string | number) : null;
  return { oldValue, newValue };
}

export function buildProcessTaskRedline(
  oldTask: ProcessTask | null,
  oldObligationId: string | null,
  newDraft: MappingRiskScoringResult["processTaskDraft"],
  newProposal: ObligationProposal
): ProcessTaskRedline {
  const oldTaskId = oldTask ? oldTask.task_id : null;
  const isNew = oldTaskId === null;

  const fields: ProcessTaskFieldDiff[] = CHANGE_AND_DELTA_PROCESS_TASK_FIELDS.map((field) => {
    const { oldValue, newValue } = fieldValue(oldTask, newDraft, field);
    let status: ProcessTaskFieldDiff["status"];
    if (isNew) {
      status = "added"; // FR-23 — no old task, every field is added
    } else {
      status = oldValue === newValue ? "unchanged" : "changed"; // FR-23 strict equality
    }
    return { field, oldValue, newValue, status };
  });

  return {
    oldTaskId,
    oldObligationId,
    newProcessTaskDraft: newDraft,
    newObligationProposal: newProposal,
    fields,
    // FR-24 — keyed on oldTaskId, even if every field is degenerate-unchanged.
    overallStatus: isNew ? "new" : "modified"
  };
}

// ===========================================================================
// FR-25..FR-27 — assembleChangeProposal
// ===========================================================================

function synthesizeAmendmentContext(triggerEvent: RegulatoryWatchTriggerEvent, scope: ChangeAndDeltaScope): AmendmentContext {
  if (scope === "paragraph_amendment") {
    // resolveScope guarantees this is non-null on the paragraph path.
    return triggerEvent.amendmentContext as AmendmentContext;
  }
  // Full-document path has no AmendmentContext (§5.2 condition 1); synthesize
  // one so ChangeProposal.amendmentContext stays non-nullable. confidence 1.0
  // means "no additional constraint from a heuristic target-resolution step"
  // for the FR-25 minimum.
  return {
    targetCircularId: triggerEvent.circular.supersedes_circular_id,
    targetMatchedOnTitle: null,
    amendedParaRefs: [],
    confidence: 1
  };
}

export interface AssembleOptions {
  unresolvedAlignments?: UnresolvedAlignment[];
  /** Sync lookup of the currently-live ProcessTask for an oldObligationId
   *  (FR-21). computeChangeProposal pre-fetches these (async) and passes a
   *  sync accessor so this function stays pure. */
  oldTaskLookup?: (oldObligationId: string) => ProcessTask | null;
}

export function assembleChangeProposal(
  triggerEvent: RegulatoryWatchTriggerEvent,
  scope: ChangeAndDeltaScope,
  diffEntries: ObligationDiffEntry[],
  effectiveDate: string,
  options: AssembleOptions = {}
): ChangeProposal {
  const amendmentContext = synthesizeAmendmentContext(triggerEvent, scope);
  const targetCircularId = amendmentContext.targetCircularId ?? triggerEvent.circular.supersedes_circular_id ?? "";
  const oldTaskLookup = options.oldTaskLookup ?? (() => null);

  const supersessions: ObligationSupersession[] = [];
  const additions: ObligationAddition[] = [];
  const repeals: ObligationRepeal[] = [];
  const redlines: ProcessTaskRedline[] = [];

  for (const entry of diffEntries) {
    if (entry.action === "superseded" && entry.oldObligation && entry.newObligationProposal && entry.newObligationMapping) {
      const oldTask = oldTaskLookup(entry.oldObligation.obligation_id);
      const redline = buildProcessTaskRedline(
        oldTask,
        entry.oldObligation.obligation_id,
        entry.newObligationMapping.processTaskDraft,
        entry.newObligationProposal
      );
      supersessions.push({
        oldObligationId: entry.oldObligation.obligation_id,
        newObligationProposal: entry.newObligationProposal,
        newObligationDerivedFromClauseId: entry.newObligationProposal.derived_from_clause_id,
        newObligationMapping: entry.newObligationMapping,
        effectiveDate,
        redline
      });
      redlines.push(redline);
    } else if (entry.action === "newly_added" && entry.newObligationProposal && entry.newObligationMapping) {
      const redline = buildProcessTaskRedline(
        null,
        null,
        entry.newObligationMapping.processTaskDraft,
        entry.newObligationProposal
      );
      additions.push({
        newObligationProposal: entry.newObligationProposal,
        newObligationDerivedFromClauseId: entry.newObligationProposal.derived_from_clause_id,
        newObligationMapping: entry.newObligationMapping,
        redline
      });
      redlines.push(redline);
    } else if (entry.action === "repealed" && entry.oldObligation) {
      repeals.push({
        oldObligationId: entry.oldObligation.obligation_id,
        effectiveDate,
        reason: entry.rationale
      });
    }
  }

  // FR-25 — overallConfidence is the MINIMUM across amendmentContext.
  // confidence, every alignmentConfidence used to resolve a superseded/
  // newly_added paragraph (excluding unresolved), and every consumed
  // proposal's confidence_score. A single weak link pulls it down.
  const confidences: number[] = [amendmentContext.confidence];
  for (const entry of diffEntries) {
    if ((entry.action === "superseded" || entry.action === "newly_added") && entry.clauseDiff.alignmentMethod !== "unresolved") {
      confidences.push(entry.clauseDiff.alignmentConfidence);
      if (entry.newObligationProposal) {
        confidences.push(entry.newObligationProposal.confidence_score);
      }
    }
  }
  const overallConfidence = confidences.length > 0 ? Math.min(...confidences) : 1;

  // FR-26 — true iff at least one ClauseTextDiff used the LLM fallback.
  const usedLlmAlignment = diffEntries.some((e) => e.clauseDiff.alignmentMethod === "llm_aligned");

  const circularSupersession =
    scope === "full_document_supersession"
      ? {
          oldCircularId: targetCircularId,
          newCircularId: triggerEvent.circular.circular_id,
          effectiveDate
        }
      : null; // FR-20 — paragraph amendment never closes the master circular

  return {
    changeProposalId: randomUUID(), // FR-27
    triggerEventId: triggerEvent.eventId, // FR-27 — verbatim
    amendmentContext,
    scope,
    targetCircularId,
    effectiveDate,
    supersessions,
    additions,
    repeals,
    circularSupersession,
    redlines,
    diffEntries,
    unresolvedAlignments: options.unresolvedAlignments ?? [],
    overallConfidence,
    usedLlmAlignment,
    generatedAt: new Date().toISOString()
  };
}

// ===========================================================================
// NFR-7 — structured logging
// ===========================================================================

export function logChangeProposal(proposal: ChangeProposal): void {
  try {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: proposal.unresolvedAlignments.length > 0 ? "warn" : "info",
        operation: "computeChangeProposal",
        change_proposal_id: proposal.changeProposalId,
        trigger_event_id: proposal.triggerEventId,
        scope: proposal.scope,
        target_circular_id: proposal.targetCircularId,
        supersession_count: proposal.supersessions.length,
        addition_count: proposal.additions.length,
        repeal_count: proposal.repeals.length,
        overall_confidence: proposal.overallConfidence,
        used_llm_alignment: proposal.usedLlmAlignment,
        unresolved_alignments: proposal.unresolvedAlignments
      })
    );
  } catch {
    // Logging must never break the diff path.
  }
}

// ===========================================================================
// Top-level orchestration — computeChangeProposal
// ===========================================================================

export async function computeChangeProposal(
  input: ChangeAndDeltaInput,
  graph: ChangeAndDeltaGraphPort,
  align: ParagraphAlignmentPort
): Promise<ChangeProposal> {
  const { triggerEvent } = input;

  // FR-1 — precondition: this must be an amendment this unit can process.
  const scope = resolveScope(triggerEvent);
  if (scope === "not_applicable") {
    throw new ChangeAndDeltaNotApplicableError(
      `Change and Delta invoked for trigger ${triggerEvent.eventId} (changeType "${triggerEvent.changeType}") that is not a processable amendment — the Orchestrator should not have invoked this unit (§5.2 / FR-1).`
    );
  }

  const amendmentContext = synthesizeAmendmentContext(triggerEvent, scope);
  const targetCircularId =
    scope === "paragraph_amendment"
      ? (amendmentContext.targetCircularId as string)
      : (triggerEvent.circular.supersedes_circular_id as string);
  const effectiveDate = triggerEvent.circular.date_effective;

  // FR-3 — re-verify the target circular still exists and is live.
  const targetCircular: Circular | null = await graph.getCircular(targetCircularId);
  if (!targetCircular || targetCircular.valid_to !== null) {
    throw new ChangeAndDeltaStaleTargetError(
      `Target circular ${targetCircularId} for trigger ${triggerEvent.eventId} is missing or no longer live (valid_to=${
        targetCircular ? targetCircular.valid_to : "<not found>"
      }); refusing to diff against a stale target (FR-3).`
    );
  }

  // FR-4 — pre-amendment snapshot, read exactly once.
  const liveObligations = await graph.getLiveObligationsUnderCircular(targetCircularId);

  // Clause pairing (paragraph or full-document path).
  const pairing =
    scope === "paragraph_amendment"
      ? await pairParagraphAmendment(amendmentContext, triggerEvent.clauses, targetCircularId, graph, align)
      : await pairFullDocument(targetCircularId, triggerEvent.clauses, graph, align);

  // Obligation-level classification.
  const diffEntries = classifyObligationDiffs(pairing.clauseDiffs, liveObligations, input.upstreamResults);

  // FR-21 — pre-fetch old ProcessTasks for every superseded obligation so
  // assembleChangeProposal can stay synchronous/pure.
  const oldTasks = new Map<string, ProcessTask | null>();
  for (const entry of diffEntries) {
    if (entry.action === "superseded" && entry.oldObligation) {
      const id = entry.oldObligation.obligation_id;
      if (!oldTasks.has(id)) {
        oldTasks.set(id, await graph.getLiveProcessTaskForObligation(id));
      }
    }
  }

  const proposal = assembleChangeProposal(triggerEvent, scope, diffEntries, effectiveDate, {
    unresolvedAlignments: pairing.unresolvedAlignments,
    oldTaskLookup: (id) => oldTasks.get(id) ?? null
  });

  logChangeProposal(proposal);
  return proposal;
}
