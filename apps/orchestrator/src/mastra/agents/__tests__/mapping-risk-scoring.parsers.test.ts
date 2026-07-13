// Spec 05 §11 tasks 3 and 5 (amount parser part): parseDeadlineRule
// (Type A-E classifier + precedence) and parseIndianRupeeAmount.
import { describe, expect, it } from "vitest";
import { parseDeadlineRule, parseIndianRupeeAmount } from "../mapping-risk-scoring.parsers.js";

describe("parseDeadlineRule — one representative string per type (FR-6)", () => {
  it("Type A — relative window", () => {
    const result = parseDeadlineRule("within T+7 working days of the trigger event");
    expect(result.type).toBe("A");
    if (result.type === "A") {
      expect(result.amount).toBe(7);
      expect(result.unit).toBe("day");
    }
  });

  it("Type A — hour unit distinction", () => {
    const result = parseDeadlineRule("must respond within T+18 hours");
    expect(result.type).toBe("A");
    if (result.type === "A") {
      expect(result.amount).toBe(18);
      expect(result.unit).toBe("hour");
    }
  });

  it("Type B — periodic", () => {
    const result = parseDeadlineRule("annually, by 30 April");
    expect(result.type).toBe("B");
    if (result.type === "B") {
      expect(result.period).toBe("annual");
    }
  });

  it("Type C — absolute date (prose)", () => {
    const result = parseDeadlineRule("by 31 December 2026");
    expect(result.type).toBe("C");
    if (result.type === "C") {
      expect(result.isoDate).toBe("2026-12-31");
    }
  });

  it("Type C — absolute date (ISO literal)", () => {
    const result = parseDeadlineRule("no later than 2026-12-31");
    expect(result.type).toBe("C");
    if (result.type === "C") {
      expect(result.isoDate).toBe("2026-12-31");
    }
  });

  it("Type D — immediate", () => {
    expect(parseDeadlineRule("shall forthwith intimate the exchange").type).toBe("D");
    expect(parseDeadlineRule("comply immediately").type).toBe("D");
    expect(parseDeadlineRule("without delay").type).toBe("D");
  });

  it("Type E — unparseable / no explicit deadline, never throws", () => {
    expect(parseDeadlineRule("on an ongoing basis with no fixed periodicity").type).toBe("E");
    expect(() => parseDeadlineRule("")).not.toThrow();
    expect(parseDeadlineRule("NONE").type).toBe("E");
  });

  it("a genuinely invalid Type-C-shaped date (e.g. 30 February) degrades to a low-confidence Type C marker, never throws", () => {
    expect(() => parseDeadlineRule("by 30 February 2026")).not.toThrow();
    const result = parseDeadlineRule("by 30 February 2026");
    expect(result.type).toBe("C");
    if (result.type === "C") {
      expect(result.isoDate).toBe("");
      expect(result.lowConfidence).toBe(true);
    }
    expect(() => parseDeadlineRule("no later than 2026-02-30")).not.toThrow();
  });
});

describe("parseDeadlineRule — precedence order (FR-6, A before B before C before D before E)", () => {
  it("a string matching both Type A and Type B patterns resolves to Type A", () => {
    const result = parseDeadlineRule("T+7 days, though this recurs annually as a matter of practice");
    expect(result.type).toBe("A");
  });

  it("a string matching both Type B and Type C patterns resolves to Type B", () => {
    const result = parseDeadlineRule("annually, by 30 April 2026");
    expect(result.type).toBe("B");
  });

  it("a string matching both Type C and Type D patterns resolves to Type C", () => {
    const result = parseDeadlineRule("by 31 December 2026, act immediately upon the trigger event");
    expect(result.type).toBe("C");
  });

  it("a string matching both Type D and (implicitly) Type E resolves to Type D", () => {
    const result = parseDeadlineRule("shall forthwith comply with no other timeline specified");
    expect(result.type).toBe("D");
  });
});

describe("parseIndianRupeeAmount", () => {
  it("parses a comma-grouped ₹ amount (lakh range)", () => {
    expect(parseIndianRupeeAmount("Monetary penalty of ₹25,00,000 as per Section 15HB")).toBe(2_500_000);
  });

  it("parses a bare 'lakh' amount with no currency symbol", () => {
    expect(parseIndianRupeeAmount("penalty of 5 lakh")).toBe(500_000);
  });

  it("parses a bare 'crore' amount", () => {
    expect(parseIndianRupeeAmount("penalty of 2 crore")).toBe(20_000_000);
  });

  it("regression: parses plural multiplier words ('lakhs'/'crores'), currency-anchored and bare", () => {
    // Post-review correction: the singular-only regex used to silently
    // return 25 (not 2,500,000) for "₹25 Lakhs" — the plural "s" broke the
    // multiplier word's \b boundary check, so the match backtracked to
    // capturing NO multiplier at all instead of failing outright.
    expect(parseIndianRupeeAmount("Monetary penalty of ₹25 Lakhs as per Section 15HB")).toBe(2_500_000);
    expect(parseIndianRupeeAmount("penalty of 25 lakhs")).toBe(2_500_000);
    expect(parseIndianRupeeAmount("penalty of 2 crores")).toBe(20_000_000);
    expect(parseIndianRupeeAmount("penalty of ₹1.5 Crores")).toBe(15_000_000);
    expect(parseIndianRupeeAmount("penalty of 10 lacs")).toBe(1_000_000);
  });

  it("parses a sub-lakh Rs. amount", () => {
    expect(parseIndianRupeeAmount("Rs. 50,000 penalty")).toBe(50_000);
  });

  it("returns null for unparseable amount text with 'penalty' present", () => {
    expect(parseIndianRupeeAmount("penalty as prescribed by the Board")).toBeNull();
  });

  it("returns null for null/empty input, never throws", () => {
    expect(parseIndianRupeeAmount("")).toBeNull();
    expect(() => parseIndianRupeeAmount("गैर-अंग्रेज़ी दंड पाठ")).not.toThrow();
  });
});
