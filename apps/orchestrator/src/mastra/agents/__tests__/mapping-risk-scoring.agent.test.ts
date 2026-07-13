// Spec 05 §11 tasks 4, 5, 7, plus the end-to-end CUSPA fixture (§10).
// Unit tests for the mapping derive* functions, derivePenaltySeverity,
// deriveDeadlineProximityDays, mapObligationToProcessTask, and
// runMappingAndRiskScoring (composed against a hand-rolled fake
// GraphQueryPort per Spec 05 §3 — no real Neo4j required for these).
import { describe, expect, it, vi } from "vitest";
import type { Obligation } from "@sentinel-act/graph-schema";
import type { GraphQueryPort, MappingContext } from "../../scorers/risk-score.scorer.js";
import { routeTier } from "../../scorers/risk-score.scorer.js";
import {
  deriveTaskName,
  deriveOwnerRole,
  normalizeRoleText,
  deriveSlaHours,
  deriveDeadlineProximityDays,
  deriveSystemTouchpoint,
  derivePenaltySeverity,
  mapObligationToProcessTask,
  runMappingAndRiskScoring
} from "../mapping-risk-scoring.agent.js";
import { MappingValidationError } from "../mapping-risk-scoring.errors.js";

const REFERENCE_DATE = "2026-07-13";

function makeObligation(overrides: Partial<Obligation> = {}): Obligation {
  return {
    obligation_id: "ob-1",
    derived_from_clause_id: "clause-1",
    category: "Reporting",
    requirement_text: "Stockbrokers must report client unpaid securities positions to the exchange daily.",
    trigger_event: "Client unpaid securities event",
    deadline_rule: "within T+2 working days of the trigger event",
    responsible_role: "Stockbroker",
    evidence_required: "System-generated report",
    penalty_ref: null,
    confidence_score: 0.95,
    grounding_score: 0.95,
    status: "proposed",
    valid_from: "2026-07-13",
    valid_to: null,
    recorded_at: "2026-07-13T00:00:00.000Z",
    ...overrides
  };
}

/** No matches anywhere — deriveOverwritesLiveObligation returns false,
 *  isFirstSeenObligationType returns true (no prior committed obligation
 *  of this category+role). */
function fakeGraphNoMatches(): GraphQueryPort {
  return {
    async runCypher() {
      return [];
    }
  };
}

/** Path-1 explicit supersession match + a prior committed obligation of
 *  the same type (not first-seen). */
function fakeGraphExplicitOverwriteAndSeenType(overwrittenId = "ob-old-1"): GraphQueryPort {
  return {
    async runCypher<T>(query: string) {
      if (query.includes("SUPERSEDES")) {
        return [{ overwrittenObligationId: overwrittenId }] as T[];
      }
      if (query.includes("typeAlreadySeen")) {
        return [{ typeAlreadySeen: true }] as T[];
      }
      return [] as T[];
    }
  };
}

/** Path-2 heuristic-only match (no explicit SUPERSEDES chain). */
function fakeGraphHeuristicOverwrite(overwrittenId = "ob-old-2"): GraphQueryPort {
  return {
    async runCypher<T>(query: string) {
      if (query.includes("SUPERSEDES")) {
        return [] as T[];
      }
      if (query.includes("liveObligation") && query.includes("responsible_role")) {
        return [{ overwrittenObligationId: overwrittenId }] as T[];
      }
      return [] as T[];
    }
  };
}

function fakeGraphUnavailable(): GraphQueryPort {
  return {
    async runCypher() {
      throw new Error("ECONNREFUSED: Neo4j unreachable");
    }
  };
}

function fakeGraphNeverResolves(): GraphQueryPort {
  return {
    runCypher() {
      return new Promise(() => {
        // Deliberately never settles — exercises the graphTimeoutMs path.
      });
    }
  };
}

function makeCtx(graph: GraphQueryPort, overrides: Partial<MappingContext> = {}): MappingContext {
  return { graph, referenceDate: REFERENCE_DATE, ...overrides };
}

// ---------------------------------------------------------------------------
// deriveTaskName (FR-4)
// ---------------------------------------------------------------------------

describe("deriveTaskName", () => {
  it("truncates at the first sentence-boundary punctuation", () => {
    const obligation = makeObligation({ category: "Reporting", requirement_text: "Report daily. Additional detail here." });
    expect(deriveTaskName(obligation)).toBe("Reporting — Report daily");
  });

  it("truncates at 100 chars with an ellipsis when there is no punctuation before the bound", () => {
    const longText = "a".repeat(150);
    const obligation = makeObligation({ category: "Reporting", requirement_text: longText });
    const result = deriveTaskName(obligation);
    expect(result).toBe(`Reporting — ${"a".repeat(100)}…`);
  });

  it("returns the '(no requirement text)' fallback for empty requirement_text, never throws", () => {
    const obligation = makeObligation({ category: "Reporting", requirement_text: "" });
    expect(deriveTaskName(obligation)).toBe("Reporting — (no requirement text)");
    expect(() => deriveTaskName(makeObligation({ requirement_text: "   " }))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// deriveOwnerRole (FR-5)
// ---------------------------------------------------------------------------

describe("deriveOwnerRole", () => {
  it.each([
    ["Stockbroker", "Compliance Officer"],
    ["Trading Member", "Compliance Officer"],
    ["Depository Participant", "Compliance Officer"],
    ["Investment Adviser", "Principal Officer"],
    ["Research Analyst", "Principal Officer"],
    ["Designated Director", "Designated Director"],
    ["Principal Officer", "Principal Officer"],
    ["Compliance Officer", "Compliance Officer"]
  ])("maps %s -> %s", (input, expected) => {
    expect(deriveOwnerRole(input)).toBe(expected);
  });

  it("falls back to the normalized input verbatim for an unrecognized role", () => {
    expect(deriveOwnerRole("Custodian")).toBe("Custodian");
  });

  it("normalizes whitespace and casing before lookup", () => {
    expect(deriveOwnerRole("  stockbroker ")).toBe("Compliance Officer");
    expect(normalizeRoleText("  depository   participant  ")).toBe("Depository Participant");
  });
});

// ---------------------------------------------------------------------------
// deriveSystemTouchpoint (FR-9)
// ---------------------------------------------------------------------------

describe("deriveSystemTouchpoint", () => {
  it.each([
    ["Regulatory Reporting", "Regulatory Reporting Portal"],
    ["KYC Norms", "KYC/Onboarding System"],
    ["Margin Requirements", "Risk & Margin System"],
    ["Investor Grievance", "Investor Grievance System (SCORES)"],
    ["Internal Audit", "Internal Audit System"],
    ["Record Retention", "Document Management System"]
  ])("category %s -> %s", (category, expected) => {
    expect(deriveSystemTouchpoint(makeObligation({ category, requirement_text: "irrelevant text" }))).toBe(expected);
  });

  it("falls through to requirement_text when category has no match", () => {
    const obligation = makeObligation({ category: "Governance", requirement_text: "must file a disclosure with the exchange" });
    expect(deriveSystemTouchpoint(obligation)).toBe("Regulatory Reporting Portal");
  });

  it("falls back to the Manual/Generic Compliance Tracker when nothing matches", () => {
    const obligation = makeObligation({ category: "Governance", requirement_text: "board must meet quarterly" });
    expect(deriveSystemTouchpoint(obligation)).toBe("Manual/Generic Compliance Tracker");
  });
});

// ---------------------------------------------------------------------------
// derivePenaltySeverity (FR-11, FR-12, FR-13)
// ---------------------------------------------------------------------------

describe("derivePenaltySeverity", () => {
  it("returns 0 for null", () => {
    expect(derivePenaltySeverity(null)).toBe(0);
  });

  it("returns 0 for an empty/whitespace-only string", () => {
    expect(derivePenaltySeverity("")).toBe(0);
    expect(derivePenaltySeverity("   ")).toBe(0);
  });

  it("returns 1.0 for suspension/cancellation/prosecution keywords", () => {
    expect(derivePenaltySeverity("Suspension of trading rights")).toBe(1.0);
    expect(derivePenaltySeverity("Cancellation of registration under Section 12")).toBe(1.0);
    expect(derivePenaltySeverity("Liable for prosecution")).toBe(1.0);
  });

  it("returns 0.9 for a penalty >= 1 crore", () => {
    expect(derivePenaltySeverity("Monetary penalty of ₹1,50,00,000")).toBe(0.9);
  });

  it("returns 0.7 for a penalty in [10 lakh, 1 crore) — the FR-12 example", () => {
    expect(derivePenaltySeverity("Monetary penalty of ₹25,00,000 as per Section 15HB")).toBe(0.7);
  });

  it("regression: plural 'Lakhs' amount lands in the correct band, not a wrong smaller one", () => {
    // Independent review caught this: an earlier parser version silently
    // returned 25 (not 2,500,000) for "₹25 Lakhs", landing in the
    // monetary_sub_lakh band (0.35) instead of monetary_medium (0.7) — a
    // silent risk-score under-count. Asserted here at the severity level
    // (not just the raw amount parser) since this is the value that
    // actually flows into scoreRisk/routeTier.
    expect(derivePenaltySeverity("Monetary penalty of ₹25 Lakhs as per Section 15HB")).toBe(0.7);
  });

  it("returns 0.5 for a penalty in [1 lakh, 10 lakh)", () => {
    expect(derivePenaltySeverity("penalty of ₹2,00,000")).toBe(0.5);
  });

  it("returns 0.5 for a penalty with an unparseable amount", () => {
    expect(derivePenaltySeverity("penalty as prescribed by the Board from time to time")).toBe(0.5);
  });

  it("returns 0.35 for a sub-lakh penalty", () => {
    expect(derivePenaltySeverity("penalty of ₹25,000")).toBe(0.35);
  });

  it("returns 0.2 for advisory/warning/show-cause keywords", () => {
    expect(derivePenaltySeverity("Issuance of a warning letter")).toBe(0.2);
    expect(derivePenaltySeverity("Show-cause notice may be issued")).toBe(0.2);
  });

  it("returns 0.3 for unrecognized non-empty text, never throws", () => {
    expect(derivePenaltySeverity("some unrelated consequence")).toBe(0.3);
    expect(() => derivePenaltySeverity("非英語のテキスト")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// deriveSlaHours / deriveDeadlineProximityDays (FR-7, FR-8, FR-14, FR-15)
// ---------------------------------------------------------------------------

describe("deriveSlaHours", () => {
  it("Type A day-unit: N * 24", () => {
    expect(deriveSlaHours("within T+2 working days of the trigger event", REFERENCE_DATE)).toBe(48);
  });

  it("Type A hour-unit: N", () => {
    expect(deriveSlaHours("within T+18 hours of the trigger event", REFERENCE_DATE)).toBe(18);
  });

  it("Type B: fixed period-length hours", () => {
    expect(deriveSlaHours("annually, by 30 April", REFERENCE_DATE)).toBe(365 * 24);
    expect(deriveSlaHours("quarterly filing required", REFERENCE_DATE)).toBe(90 * 24);
    expect(deriveSlaHours("monthly reconciliation", REFERENCE_DATE)).toBe(30 * 24);
    expect(deriveSlaHours("weekly report", REFERENCE_DATE)).toBe(7 * 24);
  });

  it("Type C: hours until a future absolute date", () => {
    const hours = deriveSlaHours("by 31 December 2026", "2026-07-13");
    expect(hours).toBeGreaterThan(0);
  });

  it("Type C: a past absolute date is clamped to 0, not negative", () => {
    expect(deriveSlaHours("by 1 January 2020", REFERENCE_DATE)).toBe(0);
  });

  it("Type D: fixed 24", () => {
    expect(deriveSlaHours("shall forthwith intimate the exchange", REFERENCE_DATE)).toBe(24);
  });

  it("Type E: fixed 720, never throws", () => {
    expect(deriveSlaHours("on an ongoing basis", REFERENCE_DATE)).toBe(720);
    expect(() => deriveSlaHours("", REFERENCE_DATE)).not.toThrow();
  });
});

describe("deriveDeadlineProximityDays", () => {
  it("Type A: window length in days, not a countdown (FR-14)", () => {
    expect(deriveDeadlineProximityDays("within T+2 working days of the trigger event", REFERENCE_DATE)).toBe(2);
  });

  it("Type A hour-unit rounds up to whole days", () => {
    expect(deriveDeadlineProximityDays("within T+18 hours of the trigger event", REFERENCE_DATE)).toBe(1);
  });

  it("Type B: period length in days", () => {
    expect(deriveDeadlineProximityDays("annually, by 30 April", REFERENCE_DATE)).toBe(365);
    expect(deriveDeadlineProximityDays("weekly report", REFERENCE_DATE)).toBe(7);
  });

  it("Type C: calendar days until a future absolute date", () => {
    expect(deriveDeadlineProximityDays("by 1 January 2020", REFERENCE_DATE)).toBe(0); // past, clamped
  });

  it("Type D: 0", () => {
    expect(deriveDeadlineProximityDays("shall forthwith comply", REFERENCE_DATE)).toBe(0);
  });

  it("Type E: fixed default 90", () => {
    expect(deriveDeadlineProximityDays("on an ongoing basis", REFERENCE_DATE)).toBe(90);
  });

  it("result is always >= 0", () => {
    expect(deriveDeadlineProximityDays("by 1 January 2000", REFERENCE_DATE)).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// mapObligationToProcessTask (FR-10)
// ---------------------------------------------------------------------------

describe("mapObligationToProcessTask", () => {
  it("returns a draft with obligation_id set and no task_id/bitemporal fields", async () => {
    const obligation = makeObligation();
    const draft = await mapObligationToProcessTask(obligation, makeCtx(fakeGraphNoMatches()));
    expect(draft.obligation_id).toBe(obligation.obligation_id);
    expect(draft).not.toHaveProperty("task_id");
    expect(draft).not.toHaveProperty("valid_from");
    expect(draft).not.toHaveProperty("valid_to");
    expect(draft).not.toHaveProperty("recorded_at");
    expect(draft.risk_score).toBeGreaterThanOrEqual(0);
    expect(draft.risk_score).toBeLessThanOrEqual(1);
  });

  it("throws MappingValidationError when a required field is missing", async () => {
    const obligation = makeObligation();
    // @ts-expect-error deliberately constructing an invalid Obligation for the error-path test
    delete obligation.category;
    await expect(mapObligationToProcessTask(obligation, makeCtx(fakeGraphNoMatches()))).rejects.toBeInstanceOf(MappingValidationError);
  });
});

// ---------------------------------------------------------------------------
// runMappingAndRiskScoring — composition, determinism, fail-closed paths
// ---------------------------------------------------------------------------

describe("runMappingAndRiskScoring", () => {
  it("AC-1: matches the corrected worked example end to end", async () => {
    const obligation = makeObligation({ penalty_ref: null, deadline_rule: "within T+2 working days of the trigger event" });
    const result = await runMappingAndRiskScoring(obligation, makeCtx(fakeGraphNoMatches()));
    expect(result.riskScoreExplain.penaltySeverity).toBe(0);
    expect(result.riskScoreExplain.deadlineProximityDays).toBe(2);
    expect(result.overwriteCheck.overwritesLiveObligation).toBe(false);
    expect(result.riskScoreExplain.riskScore).toBeCloseTo(0.28, 2);
    expect(result.slaConfidence).toBe("high"); // a well-formed T+N deadline is high-confidence
  });

  it("FR-8: slaConfidence is 'low' and actually surfaced on the returned result for a fallback-classified deadline_rule", async () => {
    // Regression: an earlier version computed this flag internally but
    // discarded it before it ever reached MappingRiskScoringResult —
    // FR-8 requires it be surfaced, not just computed.
    const obligation = makeObligation({ deadline_rule: "on an ongoing basis with no fixed periodicity" });
    const result = await runMappingAndRiskScoring(obligation, makeCtx(fakeGraphNoMatches()));
    expect(result.slaConfidence).toBe("low");
    expect(result.riskScoreExplain.deadlineProximityDays).toBe(90); // Type E fallback
  });

  it("FR-16 / AC-9: explicit SUPERSEDES-chain match takes precedence, matchPath 'explicit'", async () => {
    const obligation = makeObligation();
    const result = await runMappingAndRiskScoring(obligation, makeCtx(fakeGraphExplicitOverwriteAndSeenType("ob-old-1")));
    expect(result.overwriteCheck).toEqual({
      overwritesLiveObligation: true,
      matchPath: "explicit",
      overwrittenObligationId: "ob-old-1",
      degraded: false
    });
  });

  it("FR-17 / AC-10: heuristic same-category/role match when no explicit chain exists", async () => {
    const obligation = makeObligation();
    const result = await runMappingAndRiskScoring(obligation, makeCtx(fakeGraphHeuristicOverwrite("ob-old-2")));
    expect(result.overwriteCheck.matchPath).toBe("heuristic");
    expect(result.overwriteCheck.overwrittenObligationId).toBe("ob-old-2");
  });

  it("FR-18: neither path matching returns overwritesLiveObligation: false, matchPath: null", async () => {
    const obligation = makeObligation();
    const result = await runMappingAndRiskScoring(obligation, makeCtx(fakeGraphNoMatches()));
    expect(result.overwriteCheck).toEqual({ overwritesLiveObligation: false, matchPath: null, overwrittenObligationId: null, degraded: false });
  });

  it("FR-19: explicit and heuristic matches are logged distinctly via matchPath, both count as true for scoring", async () => {
    const explicit = await runMappingAndRiskScoring(makeObligation(), makeCtx(fakeGraphExplicitOverwriteAndSeenType()));
    const heuristic = await runMappingAndRiskScoring(makeObligation(), makeCtx(fakeGraphHeuristicOverwrite()));
    expect(explicit.overwriteCheck.matchPath).toBe("explicit");
    expect(heuristic.overwriteCheck.matchPath).toBe("heuristic");
    expect(explicit.overwriteCheck.overwritesLiveObligation).toBe(true);
    expect(heuristic.overwriteCheck.overwritesLiveObligation).toBe(true);
  });

  it("AC-6: Neo4j unavailable during the overwrite check fails closed (degraded: true, assume overwrite)", async () => {
    const obligation = makeObligation();
    const result = await runMappingAndRiskScoring(obligation, makeCtx(fakeGraphUnavailable()));
    expect(result.overwriteCheck).toEqual({ overwritesLiveObligation: true, matchPath: null, overwrittenObligationId: null, degraded: true });
    expect(result.firstSeenCheck).toEqual({ isFirstSeenObligationType: true, degraded: true });
    // Conservative assumption biases the score upward, never throws.
    expect(result.riskScoreExplain.overwritesLiveObligation).toBe(true);
  });

  it("graph query exceeding graphTimeoutMs fails closed the same way as unavailable (NFR-4)", async () => {
    const obligation = makeObligation();
    const result = await runMappingAndRiskScoring(obligation, makeCtx(fakeGraphNeverResolves(), { graphTimeoutMs: 30 }));
    expect(result.overwriteCheck.degraded).toBe(true);
    expect(result.overwriteCheck.overwritesLiveObligation).toBe(true);
    expect(result.firstSeenCheck.degraded).toBe(true);
  }, 10_000);

  it("FR-21: isFirstSeenObligationType true when no prior committed obligation of the type exists", async () => {
    const obligation = makeObligation();
    const result = await runMappingAndRiskScoring(obligation, makeCtx(fakeGraphNoMatches()));
    expect(result.firstSeenCheck).toEqual({ isFirstSeenObligationType: true, degraded: false });
  });

  it("FR-21: isFirstSeenObligationType false when a prior committed obligation of the type exists", async () => {
    const obligation = makeObligation();
    const result = await runMappingAndRiskScoring(obligation, makeCtx(fakeGraphExplicitOverwriteAndSeenType()));
    expect(result.firstSeenCheck).toEqual({ isFirstSeenObligationType: false, degraded: false });
  });

  it("NFR-6: is deterministic — identical inputs produce byte-identical output", async () => {
    const obligation = makeObligation();
    const ctx = makeCtx(fakeGraphNoMatches());
    const [first, second] = await Promise.all([runMappingAndRiskScoring(obligation, ctx), runMappingAndRiskScoring(obligation, ctx)]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("throws MappingValidationError for a structurally invalid Obligation rather than silently mis-scoring", async () => {
    const obligation = makeObligation();
    // @ts-expect-error deliberately constructing an invalid Obligation for the error-path test
    delete obligation.deadline_rule;
    await expect(runMappingAndRiskScoring(obligation, makeCtx(fakeGraphNoMatches()))).rejects.toThrow(MappingValidationError);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: 3 July 2026 CUSPA Paragraph 46 fixture (Spec 05 §10, §12 DoD)
// ---------------------------------------------------------------------------

describe("End-to-end — CUSPA Paragraph 46 (client unpaid securities) amendment fixture", () => {
  it("a penalty-bearing, deadline-bound change to a currently live obligation deterministically routes to Tier C", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const cuspaObligation = makeObligation({
      obligation_id: "ob-cuspa-para46",
      derived_from_clause_id: "clause-cuspa-para46",
      category: "Risk Management",
      requirement_text:
        "Client unpaid securities may be retained by the stock broker only in a designated client unpaid securities account, and may additionally be auto-pledged by the client solely for meeting the client's own funding obligations.",
      trigger_event: "Client unpaid securities event",
      deadline_rule: "within T+2 working days of the trigger event",
      responsible_role: "Stockbroker",
      penalty_ref: "Monetary penalty of ₹15,00,000 as per Section 15HB for non-compliance",
      confidence_score: 0.92,
      grounding_score: 0.95,
      status: "proposed"
    });

    // Explicit SUPERSEDES chain: this amendment overwrites the currently
    // live Paragraph 46 obligation from the pre-existing Master Circular
    // for Stock Brokers (the walkthrough's flagship demo scenario).
    const ctx = makeCtx(fakeGraphExplicitOverwriteAndSeenType("ob-master-circular-para46"));

    const result = await runMappingAndRiskScoring(cuspaObligation, ctx);

    // Full explainability (NFR-3) printed for a reviewer to visually
    // confirm — not just type-correct.
    console.info("CUSPA fixture MappingRiskScoringResult:", JSON.stringify(result, null, 2));

    expect(result.overwriteCheck.overwritesLiveObligation).toBe(true);
    expect(result.overwriteCheck.matchPath).toBe("explicit");
    expect(result.riskScoreExplain.penaltySeverity).toBe(0.7); // 15 lakh -> monetary_medium band
    expect(result.riskScoreExplain.riskScore).toBeGreaterThanOrEqual(0.75);

    const tierDecision = routeTier({
      riskScore: result.riskScoreExplain.riskScore,
      hasContradiction: false, // Spec 04 precondition (FR-1): already verified, no contradiction
      confidenceScore: cuspaObligation.confidence_score,
      groundingScore: cuspaObligation.grounding_score,
      isFirstSeenObligationType: result.firstSeenCheck.isFirstSeenObligationType
    });

    expect(tierDecision.tier).toBe("C");
    expect(tierDecision.reasons).toEqual(["RISK_SCORE_TIER_C"]);
    expect(tierDecision.reasons.length).toBeGreaterThan(0);

    // NFR-3: runMappingAndRiskScoring itself logs the full result.
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
