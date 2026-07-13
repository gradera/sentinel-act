// Deterministic amendment-text parsing for the Change and Delta Agent
// (Spec 06 §6 FR-6 / FR-7). No model call anywhere in this file — these
// are the two deterministic paragraph-isolation strategies that must be
// attempted before the LLM alignment fallback (FR-8).
//
// The paragraph-numbering recognizer is REUSED (not forked) from Spec 02's
// `chunkIntoClauses` via the now-exported `matchNumberingToken`, so the two
// specs' notion of "what a paragraph boundary looks like" cannot drift.
import { matchNumberingToken } from "./regulatory-watch.agent.js";

// ---------------------------------------------------------------------------
// FR-6 — amendment-preamble marker stripping (single_paragraph_direct)
// ---------------------------------------------------------------------------

/** The standard "read as follows"-style amendment preambles. Matches the
 *  leading prose up to and including the marker so the remainder is the
 *  substituted regulatory text only (never the amendment's own preamble). */
export const AMENDMENT_PREAMBLE_MARKER =
  /^.*?(?:is\s+amended\s+to\s+read\s+as\s+follows|shall\s+(?:now\s+)?read\s+as\s+(?:follows|under)|shall\s+be\s+substituted\s+by\s+the\s+following|is\s+substituted\s+by\s+the\s+following)\s*[:\-]?\s*/is;

/** Trim a single layer of wrapping quotes (straight or curly) SEBI often
 *  places around the restated paragraph text. */
function stripWrappingQuotes(text: string): string {
  const trimmed = text.trim();
  const pairs: Array<[string, string]> = [
    ["'", "'"],
    ['"', '"'],
    ["‘", "’"],
    ["“", "”"]
  ];
  for (const [open, close] of pairs) {
    if (trimmed.length >= 2 && trimmed.startsWith(open) && trimmed.endsWith(close)) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

/** FR-6. Returns the marker-stripped replacement text, or `null` when the
 *  clause has no recognizable "read as follows"-style marker (signalling a
 *  MUST-fall-through to FR-7/FR-8, never a silent use of the unstripped
 *  full text). */
export function stripAmendmentPreamble(clauseText: string): string | null {
  const match = AMENDMENT_PREAMBLE_MARKER.exec(clauseText);
  if (!match) {
    return null;
  }
  const remainder = clauseText.slice(match[0].length);
  const cleaned = stripWrappingQuotes(remainder);
  return cleaned.length > 0 ? cleaned : null;
}

// ---------------------------------------------------------------------------
// FR-7 — marker-boundary split (marker_regex_split)
// ---------------------------------------------------------------------------

/** Split a concatenated amendment body into `paraRef -> segment text`
 *  entries using the shared numbering recognizer. Every line that opens a
 *  new numbered paragraph starts a new segment; continuation lines append
 *  to the current segment. Preamble lines before the first numbered line
 *  are discarded (they are the amendment's framing prose, not a paragraph).
 */
function splitByNumbering(concatenatedText: string): Map<string, string> {
  const segments = new Map<string, string[]>();
  let currentRef: string | null = null;

  for (const rawLine of concatenatedText.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    const match = matchNumberingToken(line);
    if (match) {
      currentRef = match.paraRef;
      const existing = segments.get(currentRef) ?? [];
      if (match.remainder) {
        existing.push(match.remainder);
      }
      segments.set(currentRef, existing);
    } else if (currentRef !== null) {
      segments.get(currentRef)!.push(line);
    }
  }

  const out = new Map<string, string>();
  for (const [ref, lines] of segments) {
    out.set(ref, stripWrappingQuotes(lines.join(" ")));
  }
  return out;
}

/** FR-7. Attempts a deterministic marker-boundary split of the amendment
 *  body across the claimed `amendedParaRefs`. Succeeds ONLY when the set of
 *  numbered segments found exactly matches (same count, same para_ref
 *  values) the claimed refs — otherwise returns `null` to force the
 *  FR-8 LLM fallback rather than guessing an approximate pairing.
 *
 *  Also returns `null` if two claimed refs resolve to identical segment
 *  text (§8's "overlapping/identical matchedText" row) — deterministic
 *  duplication is treated as a split failure. */
export function markerSplit(concatenatedText: string, amendedParaRefs: string[]): Map<string, string> | null {
  if (amendedParaRefs.length === 0) {
    return null;
  }
  const segments = splitByNumbering(concatenatedText);

  const claimed = new Set(amendedParaRefs);
  if (segments.size !== claimed.size) {
    return null;
  }
  for (const ref of claimed) {
    if (!segments.has(ref)) {
      return null;
    }
  }
  // Reject identical segment text across two distinct refs (§8).
  const seenText = new Set<string>();
  for (const ref of claimed) {
    const text = segments.get(ref) ?? "";
    if (text.length === 0 || seenText.has(text)) {
      return null;
    }
    seenText.add(text);
  }
  return segments;
}
