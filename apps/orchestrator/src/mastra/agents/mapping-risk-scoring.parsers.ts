// Deterministic text parsers for the Mapping and Risk Scoring Agent
// (Spec 05 §11 tasks 3 and 5, part): the shared `deadline_rule` Type A–E
// classifier (FR-6) that `deriveSlaHours`/`deriveDeadlineProximityDays`
// both consume, and the Indian-numbering-aware rupee amount parser used by
// `derivePenaltySeverity` (FR-12). Not a general NLP/date-parsing library
// (Spec 05 §2 Non-Goals) — these cover only the pattern classes SEBI
// circulars actually use.

// ---------------------------------------------------------------------------
// FR-6: parseDeadlineRule — Type A-E classifier
// ---------------------------------------------------------------------------

export type DeadlineRuleType = "A" | "B" | "C" | "D" | "E";

export type DeadlinePeriod = "annual" | "quarterly" | "monthly" | "weekly";

export type DeadlineRuleClassification =
  | { type: "A"; amount: number; unit: "day" | "hour"; lowConfidence: boolean }
  | { type: "B"; period: DeadlinePeriod }
  | { type: "C"; isoDate: string; lowConfidence: boolean }
  | { type: "D" }
  | { type: "E" };

// Type A: "T+N days/hours/working days" etc. Alternatives are ordered
// longest-first (not the FR-6 table's illustrative order) so the capture
// group always gets the full unit phrase rather than a truncated partial
// match (e.g. "working day" instead of accidentally short-circuiting on a
// shorter alternative earlier in the string) — see FR-6's note that the
// table's regex is a "sketch," not a literal required pattern.
const TYPE_A_PATTERN = /T\s*\+\s*(\d+)\s*(working days|working day|days|day|hours|hour)/i;

// Type B: periodic cadence keywords.
const TYPE_B_PATTERN = /\b(annual|annually|quarterly|monthly|weekly)\b/i;

// Type C: absolute date — either "by <day> <month> <year>" or a bare ISO
// date literal (YYYY-MM-DD).
const TYPE_C_PROSE_PATTERN = /\bby\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\b/i;
const TYPE_C_ISO_PATTERN = /\b(\d{4})-(\d{2})-(\d{2})\b/;

// Type D: immediate-action keywords.
const TYPE_D_PATTERN = /\b(immediately|forthwith|without delay)\b/i;

const MONTH_NAMES: Readonly<Record<string, number>> = Object.freeze({
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11
});

function normalizePeriod(raw: string): DeadlinePeriod {
  const lower = raw.toLowerCase();
  return lower === "annually" ? "annual" : (lower as DeadlinePeriod);
}

function toIsoDate(year: number, monthIndex: number, day: number): string | null {
  const date = new Date(Date.UTC(year, monthIndex, day));
  // Guard against JS Date's auto-rollover (e.g. 31 February) silently
  // producing a plausible-looking but wrong date — treat as unparseable.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== monthIndex || date.getUTCDate() !== day) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

/** FR-6: classifies a `deadline_rule` string into exactly one of five
 *  pattern types, tested in fixed precedence order (A before B before C
 *  before D before E, first match wins — Error Handling §8's "matches more
 *  than one classifier pattern" row). MUST NOT throw for any input. */
export function parseDeadlineRule(deadlineRule: string): DeadlineRuleClassification {
  const text = deadlineRule ?? "";

  const typeA = TYPE_A_PATTERN.exec(text);
  if (typeA) {
    const amount = Number.parseInt(typeA[1], 10);
    const unitRaw = typeA[2].toLowerCase();
    const unit: "day" | "hour" = unitRaw.includes("hour") ? "hour" : "day";
    const lowConfidence = !Number.isFinite(amount);
    return { type: "A", amount: Number.isFinite(amount) ? amount : 0, unit, lowConfidence };
  }

  const typeB = TYPE_B_PATTERN.exec(text);
  if (typeB) {
    return { type: "B", period: normalizePeriod(typeB[1]) };
  }

  const typeCProse = TYPE_C_PROSE_PATTERN.exec(text);
  if (typeCProse) {
    const day = Number.parseInt(typeCProse[1], 10);
    const monthIndex = MONTH_NAMES[typeCProse[2].toLowerCase()];
    const year = Number.parseInt(typeCProse[3], 10);
    const isoDate = monthIndex === undefined ? null : toIsoDate(year, monthIndex, day);
    if (isoDate) {
      return { type: "C", isoDate, lowConfidence: false };
    }
    // Matched the "by <...>" shape but the month/day/year didn't resolve
    // to a real date — fall through to a Type C low-confidence marker
    // rather than silently misclassifying as Type E, so callers still see
    // "this looked like an absolute date" in the audit trail.
    return { type: "C", isoDate: "", lowConfidence: true };
  }

  const typeCIso = TYPE_C_ISO_PATTERN.exec(text);
  if (typeCIso) {
    const year = Number.parseInt(typeCIso[1], 10);
    const monthIndex = Number.parseInt(typeCIso[2], 10) - 1;
    const day = Number.parseInt(typeCIso[3], 10);
    const isoDate = toIsoDate(year, monthIndex, day);
    return isoDate ? { type: "C", isoDate, lowConfidence: false } : { type: "C", isoDate: "", lowConfidence: true };
  }

  const typeD = TYPE_D_PATTERN.exec(text);
  if (typeD) {
    return { type: "D" };
  }

  return { type: "E" };
}

// ---------------------------------------------------------------------------
// FR-12: Indian-numbering-aware rupee amount parser
// ---------------------------------------------------------------------------

const LAKH_MULTIPLIER = 100_000;
const CRORE_MULTIPLIER = 10_000_000;

// A currency-symbol-anchored amount, optionally comma-grouped, optionally
// followed by a lakh/crore multiplier word (e.g. "₹25,00,000",
// "Rs. 25 lakh", "INR 1.5 crore"). Multiplier alternatives include the
// plural forms ("lakhs", "crores", "lacs") — post-review correction: an
// earlier version only matched the singular, which meant "₹25 Lakhs" (the
// grammatically standard form whenever the quantity isn't 1, i.e. the
// common case in real circular text) silently matched with NO multiplier
// captured at all (the trailing "s" broke the \b word-boundary check on
// "lakh" alone, so the regex backtracked to a multiplier-less match rather
// than failing) — returning a wrong, dangerously small amount (25 instead
// of 2,500,000) instead of degrading safely to `null`.
const CURRENCY_ANCHORED_PATTERN = /(?:₹|Rs\.?|INR)\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(lakhs?|lacs?|crores?|cr)?\b/i;

// A bare "<number> lakh/crore" amount with no currency symbol (e.g. "25
// lakh", "25 lakhs", "1 crore", "2 crores").
const BARE_MULTIPLIER_PATTERN = /([0-9][0-9,]*(?:\.[0-9]+)?)\s*(lakhs?|lacs?|crores?|cr)\b/i;

function multiplierFor(word: string | undefined): number {
  if (!word) return 1;
  const lower = word.toLowerCase();
  if (lower.startsWith("lakh") || lower.startsWith("lac")) return LAKH_MULTIPLIER;
  if (lower.startsWith("crore") || lower === "cr") return CRORE_MULTIPLIER;
  return 1;
}

/** FR-12's amount parser. Returns the parsed amount in plain rupees, or
 *  `null` if no amount could be parsed. Never throws (FR-13) — a
 *  malformed/non-English string simply yields `null`. Narrow and
 *  hand-rolled (Spec 05 §13), not a general currency parser. */
export function parseIndianRupeeAmount(text: string): number | null {
  if (!text) return null;

  const currencyMatch = CURRENCY_ANCHORED_PATTERN.exec(text);
  if (currencyMatch) {
    const digits = Number.parseFloat(currencyMatch[1].replace(/,/g, ""));
    if (Number.isFinite(digits)) {
      return digits * multiplierFor(currencyMatch[2]);
    }
  }

  const bareMatch = BARE_MULTIPLIER_PATTERN.exec(text);
  if (bareMatch) {
    const digits = Number.parseFloat(bareMatch[1].replace(/,/g, ""));
    if (Number.isFinite(digits)) {
      return digits * multiplierFor(bareMatch[2]);
    }
  }

  return null;
}
