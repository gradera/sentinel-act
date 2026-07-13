// Spec 09 FR-2 / Spec 11 FR-2 — the one-line QueueItemSummary.summary
// derivation, shared so the text a reviewer sees on a Slack card is
// byte-identical to what they'd see in the console queue for the same
// item.
//
// NAMING NOTE: Spec 11 §4/§6 FR-2 calls this function `deriveQueueSummary`
// and describes it as already living in
// apps/web-console/lib/console/types.ts, ready to be extracted verbatim.
// Neither is accurate as of this unit's implementation: the real, already
// -shipped function is `truncateRequirementText`, defined in
// apps/web-console/lib/console/summary.ts (not types.ts). Per this task's
// constraints, apps/web-console/lib/console/summary.ts is left untouched
// (only lib/console/types.ts gets a re-export shim) — so this file is a
// byte-for-byte port of truncateRequirementText's logic, exported under
// the name FR-2 specifies (`deriveQueueSummary`), so
// apps/orchestrator/src/slack can import the name the spec calls for.
// `truncateRequirementText` is also re-exported as an alias so a future
// change that points apps/web-console directly at this package (per the
// §13 migration note) can adopt either name without a behavior change.
const SUMMARY_TRUNCATION_LIMIT = 100;
const SENTENCE_BOUNDARY_PATTERN = /[.;\n]/;

export function deriveQueueSummary(requirementText: string): string {
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

/** Alias — see the naming note above. */
export const truncateRequirementText = deriveQueueSummary;
