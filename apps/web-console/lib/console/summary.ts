// Spec 09 FR-2: `QueueItemSummary.summary` must be derived server-side as
// `obligation.requirement_text` truncated using "the same
// first-sentence-or-100-char rule Spec 05's `deriveTaskName` uses (reuse
// the truncation helper, do not reimplement it)".
//
// `deriveTaskName` (apps/orchestrator/src/mastra/agents/
// mapping-risk-scoring.agent.ts) cannot actually be imported here — same
// importability problem documented throughout lib/console/types.ts and
// orchestrator-client.ts's doc comments (apps/orchestrator has no `main`/
// `types`/`exports` in its package.json, so nothing under
// apps/orchestrator/src/** is resolvable from apps/web-console). FR-2's
// "reuse, do not reimplement" instruction is therefore satisfied as
// closely as this constraint allows: this is a STRUCTURAL COPY of only
// the truncation rule itself (the sentence-boundary-or-100-char logic),
// not the whole `deriveTaskName` function — `deriveTaskName` additionally
// prepends `${category} — ` and has a "no requirement text" fallback,
// neither of which FR-2 asks for here (FR-2 truncates `requirement_text`
// alone, it does not build a task name). Keep the truncation constants and
// algorithm below byte-for-byte identical to `deriveTaskName`'s if that
// function ever changes, so the two truncation behaviors stay visually
// consistent per FR-2's own stated goal.
const SUMMARY_TRUNCATION_LIMIT = 100;
const SENTENCE_BOUNDARY_PATTERN = /[.;\n]/;

export function truncateRequirementText(requirementText: string): string {
  const text = requirementText ?? "";
  if (text.trim().length === 0) {
    return "(no requirement text)";
  }

  const boundaryMatch = SENTENCE_BOUNDARY_PATTERN.exec(text);
  let firstSentence: string;
  let truncatedAtCharBound = false;

  if (boundaryMatch && boundaryMatch.index < SUMMARY_TRUNCATION_LIMIT) {
    firstSentence = text.slice(0, boundaryMatch.index);
  } else if (text.length > SUMMARY_TRUNCATION_LIMIT) {
    firstSentence = text.slice(0, SUMMARY_TRUNCATION_LIMIT);
    truncatedAtCharBound = true;
  } else {
    firstSentence = text;
  }

  firstSentence = firstSentence.trim();
  if (truncatedAtCharBound) {
    firstSentence += "…";
  }
  return firstSentence;
}
