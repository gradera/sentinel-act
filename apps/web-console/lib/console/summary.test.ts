// Spec 09 §12: "queue-summary derivation" — truncateRequirementText's
// first-sentence-or-100-char rule (summary.ts's doc comment: a structural
// copy of deriveTaskName's truncation algorithm, Spec 05).
import { describe, expect, it } from "vitest";
import { truncateRequirementText } from "./summary";

// FR-2: QueueItemSummary.summary MUST be derived server-side as
// requirement_text truncated by the same first-sentence-or-100-char rule
// Spec 05's deriveTaskName uses. Every test below exercises that exact
// truncation rule via truncateRequirementText, the function summary.ts
// documents as the reused (not reimplemented) truncation algorithm.
describe("truncateRequirementText", () => {
  it("returns short text (no sentence boundary, under 100 chars) unchanged", () => {
    expect(truncateRequirementText("File the report")).toBe("File the report");
  });

  it("truncates at the first sentence boundary when that boundary is before the 100-char limit", () => {
    const text = "Submit the KYC form. This second sentence should never appear.";
    expect(truncateRequirementText(text)).toBe("Submit the KYC form");
  });

  it("treats ';' and newline as sentence boundaries too", () => {
    expect(truncateRequirementText("Do the thing; then do another thing.")).toBe("Do the thing");
    expect(truncateRequirementText("First line\nSecond line")).toBe("First line");
  });

  it("truncates at exactly 100 chars with a trailing ellipsis when there is no earlier sentence boundary", () => {
    const noBoundary = "a".repeat(150);
    const result = truncateRequirementText(noBoundary);
    expect(result).toBe(`${"a".repeat(100)}…`);
    expect(result.length).toBe(101);
  });

  it("does NOT char-truncate when a sentence boundary exists but only past the 100-char limit — the boundary is ignored and the 100-char cut wins", () => {
    // Boundary ('.') sits at index 120, past SUMMARY_TRUNCATION_LIMIT (100)
    // — per the boundaryMatch.index < 100 condition, this must fall through
    // to the char-limit branch, not use the (too-late) sentence boundary.
    const text = `${"b".repeat(120)}. trailing text after the period`;
    const result = truncateRequirementText(text);
    expect(result).toBe(`${"b".repeat(100)}…`);
  });

  it("returns the placeholder for empty/whitespace-only text", () => {
    expect(truncateRequirementText("")).toBe("(no requirement text)");
    expect(truncateRequirementText("   ")).toBe("(no requirement text)");
  });

  it("trims surrounding whitespace on the (non-truncated) result", () => {
    expect(truncateRequirementText("  Padded sentence.  Rest.")).toBe("Padded sentence");
  });

  it("boundary exactly at char 99 (< 100) still uses the sentence-boundary branch, not the char-limit branch", () => {
    const text = `${"c".repeat(99)}.rest`;
    const result = truncateRequirementText(text);
    expect(result).toBe("c".repeat(99));
    expect(result.endsWith("…")).toBe(false);
  });
});
