// Spec 05 §11 task 2: integrity tests for the lookup tables themselves
// (no duplicate keys, etc.), independent of the derive* functions that
// consume them.
import { describe, expect, it } from "vitest";
import { ROLE_MAP, TOUCHPOINT_RULES, TOUCHPOINT_FALLBACK, PENALTY_BAND_TABLE } from "../mapping-risk-scoring.tables.js";

describe("ROLE_MAP", () => {
  it("has no duplicate (case-insensitive) keys", () => {
    const keys = Object.keys(ROLE_MAP).map((k) => k.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("contains every FR-5 table row", () => {
    expect(ROLE_MAP["Stockbroker"]).toBe("Compliance Officer");
    expect(ROLE_MAP["Trading Member"]).toBe("Compliance Officer");
    expect(ROLE_MAP["Depository Participant"]).toBe("Compliance Officer");
    expect(ROLE_MAP["Investment Adviser"]).toBe("Principal Officer");
    expect(ROLE_MAP["Research Analyst"]).toBe("Principal Officer");
    expect(ROLE_MAP["Designated Director"]).toBe("Designated Director");
    expect(ROLE_MAP["Principal Officer"]).toBe("Principal Officer");
    expect(ROLE_MAP["Compliance Officer"]).toBe("Compliance Officer");
  });
});

describe("TOUCHPOINT_RULES", () => {
  it("has no duplicate keyword across rows", () => {
    const allKeywords = TOUCHPOINT_RULES.flatMap((rule) => rule.keywords);
    expect(new Set(allKeywords).size).toBe(allKeywords.length);
  });

  it("every rule has at least one keyword and a non-empty touchpoint", () => {
    for (const rule of TOUCHPOINT_RULES) {
      expect(rule.keywords.length).toBeGreaterThan(0);
      expect(rule.touchpoint.length).toBeGreaterThan(0);
    }
  });

  it("has exactly six rows, in FR-9's table order", () => {
    expect(TOUCHPOINT_RULES.map((r) => r.touchpoint)).toEqual([
      "Regulatory Reporting Portal",
      "KYC/Onboarding System",
      "Risk & Margin System",
      "Investor Grievance System (SCORES)",
      "Internal Audit System",
      "Document Management System"
    ]);
  });

  it("fallback is distinct from every rule's touchpoint", () => {
    expect(TOUCHPOINT_RULES.map((r) => r.touchpoint)).not.toContain(TOUCHPOINT_FALLBACK);
  });
});

describe("PENALTY_BAND_TABLE", () => {
  it("every band's severity is within [0, 1]", () => {
    for (const band of Object.values(PENALTY_BAND_TABLE)) {
      expect(band.severity).toBeGreaterThanOrEqual(0);
      expect(band.severity).toBeLessThanOrEqual(1);
    }
  });

  it("matches FR-12's severities exactly", () => {
    expect(PENALTY_BAND_TABLE.severe.severity).toBe(1.0);
    expect(PENALTY_BAND_TABLE.monetary_high.severity).toBe(0.9);
    expect(PENALTY_BAND_TABLE.monetary_medium.severity).toBe(0.7);
    expect(PENALTY_BAND_TABLE.monetary_low.severity).toBe(0.5);
    expect(PENALTY_BAND_TABLE.monetary_unspecified.severity).toBe(0.5);
    expect(PENALTY_BAND_TABLE.monetary_sub_lakh.severity).toBe(0.35);
    expect(PENALTY_BAND_TABLE.advisory.severity).toBe(0.2);
    expect(PENALTY_BAND_TABLE.unrecognized_non_empty.severity).toBe(0.3);
  });

  it("has no duplicate band names", () => {
    const names = Object.values(PENALTY_BAND_TABLE).map((b) => b.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
