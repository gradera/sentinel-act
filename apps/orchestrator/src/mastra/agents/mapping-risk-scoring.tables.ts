// Lookup-table data modules for the Mapping and Risk Scoring Agent
// (Spec 05 §11 task 2): ROLE_MAP (FR-5), TOUCHPOINT_RULES (FR-9), and
// PENALTY_BAND_TABLE (FR-12). Plain exported constants, no logic — kept in
// their own file so they can be unit-tested for internal integrity (no
// duplicate keys, etc.) independent of the derive* functions that consume
// them. These are starter sets, not exhaustive (Spec 05 §13, Open
// Questions) — every "identity fallback" / "no match" branch hit in
// production is a signal to add a row here, not a bug.

// ---------------------------------------------------------------------------
// FR-5: responsible_role -> owner_role
// ---------------------------------------------------------------------------

/** Keys are already in the normalized (trimmed, whitespace-collapsed,
 *  title-cased) form `deriveOwnerRole` produces before lookup — see
 *  `normalizeRoleText` in mapping-risk-scoring.agent.ts. */
export const ROLE_MAP: Readonly<Record<string, string>> = Object.freeze({
  Stockbroker: "Compliance Officer",
  "Trading Member": "Compliance Officer",
  "Depository Participant": "Compliance Officer",
  "Investment Adviser": "Principal Officer",
  "Research Analyst": "Principal Officer",
  "Designated Director": "Designated Director",
  "Principal Officer": "Principal Officer",
  "Compliance Officer": "Compliance Officer"
});

// ---------------------------------------------------------------------------
// FR-9: category / requirement_text keyword -> system_touchpoint
// ---------------------------------------------------------------------------

export interface TouchpointRule {
  keywords: string[];
  touchpoint: string;
}

/** Evaluated in array order, first match wins (FR-9). Each rule's keywords
 *  are matched case-insensitively as substrings. */
export const TOUCHPOINT_RULES: ReadonlyArray<TouchpointRule> = Object.freeze([
  { keywords: ["reporting", "disclosure", "filing"], touchpoint: "Regulatory Reporting Portal" },
  { keywords: ["kyc", "client onboarding", "account opening"], touchpoint: "KYC/Onboarding System" },
  { keywords: ["margin", "unpaid securities", "pledge", "risk management"], touchpoint: "Risk & Margin System" },
  { keywords: ["grievance", "complaint", "scores"], touchpoint: "Investor Grievance System (SCORES)" },
  { keywords: ["audit", "inspection"], touchpoint: "Internal Audit System" },
  { keywords: ["record", "retention", "maintenance"], touchpoint: "Document Management System" }
]);

/** FR-9, last row: MUST be treated as a low-confidence mapping and logged,
 *  since it means no rule recognized the obligation's domain. */
export const TOUCHPOINT_FALLBACK = "Manual/Generic Compliance Tracker";

// ---------------------------------------------------------------------------
// FR-12: penalty_ref keyword/amount -> severity band
// ---------------------------------------------------------------------------

export type PenaltyBandName =
  | "severe"
  | "monetary_high"
  | "monetary_medium"
  | "monetary_low"
  | "monetary_unspecified"
  | "monetary_sub_lakh"
  | "advisory"
  | "unrecognized_non_empty";

export interface PenaltyBand {
  name: PenaltyBandName;
  severity: number;
}

/** Evaluated top-to-bottom by `derivePenaltySeverity` (FR-12) — the table
 *  itself only carries the band->severity mapping; the match conditions
 *  (keyword + amount range) are inherently procedural (amount comparisons)
 *  and live in the derive function, not as data here. Exported primarily
 *  so severity values are named, single-sourced constants. */
export const PENALTY_BAND_TABLE: Readonly<Record<PenaltyBandName, PenaltyBand>> = Object.freeze({
  severe: { name: "severe", severity: 1.0 },
  monetary_high: { name: "monetary_high", severity: 0.9 },
  monetary_medium: { name: "monetary_medium", severity: 0.7 },
  monetary_low: { name: "monetary_low", severity: 0.5 },
  monetary_unspecified: { name: "monetary_unspecified", severity: 0.5 },
  monetary_sub_lakh: { name: "monetary_sub_lakh", severity: 0.35 },
  advisory: { name: "advisory", severity: 0.2 },
  unrecognized_non_empty: { name: "unrecognized_non_empty", severity: 0.3 }
});

export const SEVERE_KEYWORDS = ["suspension", "cancellation of registration", "prosecution"];
export const ADVISORY_KEYWORDS = ["warning", "advisory", "show-cause"];
export const PENALTY_KEYWORD = "penalty";

// Indian-numbering amount-band boundaries (FR-12), in rupees.
export const ONE_LAKH = 100_000;
export const TEN_LAKH = 1_000_000;
export const ONE_CRORE = 10_000_000;
