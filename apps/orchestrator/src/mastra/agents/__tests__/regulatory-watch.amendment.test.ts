// Spec 02 §10 unit test: extractAmendmentContext, covering each FR-16
// regex pattern, a no-amendment-language fixture, and the flagship
// CUSPA/Paragraph 46 scenario (Acceptance Criterion 3).
import { describe, expect, it } from "vitest";
import { extractAmendmentContext } from "../regulatory-watch.agent.js";
import type { Circular } from "@sentinel-act/graph-schema";

function makeCircular(overrides: Partial<Circular> = {}): Circular {
  return {
    circular_id: "circ-master-1",
    title: "Master Circular for Stock Brokers",
    type: "master_circular",
    category: "Stockbroker",
    date_issued: "2023-06-12",
    date_effective: "2023-06-12",
    source_hash: "hash-master",
    supersedes_circular_id: null,
    valid_from: "2023-06-12",
    valid_to: null,
    recorded_at: "2023-06-12T00:00:00Z",
    ...overrides
  };
}

describe("extractAmendmentContext", () => {
  it("returns null when no amendment-signaling language is present", () => {
    const text = "1. All stock brokers shall submit quarterly reports on client margin.";
    expect(extractAmendmentContext(text, [makeCircular()])).toBeNull();
  });

  it("detects the 'amendment to paragraph N' pattern (FR-16)", () => {
    const text = "This circular is an amendment to paragraph 12 of the existing framework.";
    const result = extractAmendmentContext(text, []);
    expect(result).not.toBeNull();
    expect(result?.amendedParaRefs).toContain("12");
  });

  it("detects the 'master circular ... dated' pattern (FR-16)", () => {
    const text = "This amends the Master Circular for Investment Advisers dated 1 January 2024.";
    expect(extractAmendmentContext(text, [])).not.toBeNull();
  });

  it("detects 'in partial modification of' (FR-16)", () => {
    const text = "In partial modification of the earlier circular, the deadline is revised.";
    expect(extractAmendmentContext(text, [])).not.toBeNull();
  });

  it("detects 'read with' (FR-16)", () => {
    const text = "This circular is to be read with SEBI/HO/MIRSD/2024/01 issued earlier.";
    expect(extractAmendmentContext(text, [])).not.toBeNull();
  });

  it("detects 'stands amended/substituted/modified' (FR-16)", () => {
    const text = "Paragraph 9 of the earlier circular stands substituted in its entirety.";
    expect(extractAmendmentContext(text, [])).not.toBeNull();
  });

  it("resolves the flagship CUSPA-style 'Paragraph N of the Master Circular ... is amended' phrasing (Acceptance Criterion 3)", () => {
    const text =
      "In partial modification of the Master Circular for Stock Brokers, the following amendment is issued. " +
      "Paragraph 46 of the Master Circular for Stock Brokers dated 12 June 2023 is amended to read as follows: " +
      "client unpaid securities may be retained by the stock broker only in a designated client unpaid securities account.";
    const result = extractAmendmentContext(text, [makeCircular()]);

    expect(result).not.toBeNull();
    expect(result?.amendedParaRefs).toEqual(["46"]);
    expect(result?.targetCircularId).toBe("circ-master-1");
    expect(result?.targetMatchedOnTitle).toBe("Master Circular for Stock Brokers");
    expect(result?.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it("leaves targetCircularId null (with lower confidence) when amendment language is found but no candidate resolves", () => {
    const text = "In partial modification of the Master Circular for Alternative Investment Funds, Paragraph 8 is amended.";
    const result = extractAmendmentContext(text, [makeCircular({ title: "Master Circular for Stock Brokers" })]);

    expect(result).not.toBeNull();
    expect(result?.targetCircularId).toBeNull();
    expect(result?.confidence).toBeLessThan(0.8);
  });

  it("never sets a null amendedParaRefs entry — empty array when no para ref is extractable", () => {
    const text = "In partial modification of the earlier circular, the deadline is revised.";
    const result = extractAmendmentContext(text, []);
    expect(result?.amendedParaRefs).toEqual([]);
  });
});
