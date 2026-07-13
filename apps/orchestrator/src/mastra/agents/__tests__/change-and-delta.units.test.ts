// Unit tests for the deterministic building blocks of the Change and Delta
// Agent (Spec 06 §10): resolveScope, computeClauseSimilarity, marker
// stripping/split, buildProcessTaskRedline, classifyObligationDiffs.
import { describe, it, expect } from "vitest";
import {
  resolveScope,
  computeClauseSimilarity,
  buildProcessTaskRedline,
  classifyObligationDiffs,
  CLAUSE_SIMILARITY_UNCHANGED_THRESHOLD
} from "../change-and-delta.core.js";
import { stripAmendmentPreamble, markerSplit } from "../change-and-delta.markers.js";
import type { ClauseTextDiff, UpstreamClauseResult } from "../change-and-delta.types.js";
import {
  triggerEvent,
  amendmentContext,
  amendmentCircularCandidate,
  oldClause46,
  oldObligation,
  oldTask,
  proposal,
  extraction,
  mapping,
  clauseCandidate,
  OLD_46_TEXT,
  AMEND_CLAUSE_ID,
  AMEND_CIRCULAR_ID
} from "./change-and-delta.fixtures.js";
import type { MappingRiskScoringResult } from "../mapping-risk-scoring.agent.js";

describe("resolveScope (FR-1)", () => {
  it("returns paragraph_amendment for changeType new with a resolved target", () => {
    expect(resolveScope(triggerEvent())).toBe("paragraph_amendment");
  });

  it("returns full_document_supersession for changeType amendment with supersedes set", () => {
    const ev = triggerEvent({
      changeType: "amendment",
      circular: amendmentCircularCandidate({ supersedes_circular_id: "old-circ" }),
      amendmentContext: null
    });
    expect(resolveScope(ev)).toBe("full_document_supersession");
  });

  it("returns not_applicable for changeType new with null amendmentContext", () => {
    expect(resolveScope(triggerEvent({ amendmentContext: null }))).toBe("not_applicable");
  });

  it("returns not_applicable for changeType new with null targetCircularId", () => {
    expect(resolveScope(triggerEvent({ amendmentContext: amendmentContext({ targetCircularId: null }) }))).toBe("not_applicable");
  });

  it("returns not_applicable for changeType amendment with null supersedes_circular_id", () => {
    const ev = triggerEvent({
      changeType: "amendment",
      circular: amendmentCircularCandidate({ supersedes_circular_id: null }),
      amendmentContext: null
    });
    expect(resolveScope(ev)).toBe("not_applicable");
  });
});

describe("computeClauseSimilarity (FR-10)", () => {
  it("identical strings -> 1.0", () => {
    expect(computeClauseSimilarity(OLD_46_TEXT, OLD_46_TEXT)).toBe(1);
  });

  it("completely disjoint token sets -> 0", () => {
    expect(computeClauseSimilarity("alpha beta gamma", "delta epsilon zeta")).toBe(0);
  });

  it("both empty -> 1.0", () => {
    expect(computeClauseSimilarity("", "")).toBe(1);
  });

  it("one empty -> 0", () => {
    expect(computeClauseSimilarity("something", "")).toBe(0);
  });

  it("is deterministic (same pair twice -> identical score)", () => {
    const a = computeClauseSimilarity(OLD_46_TEXT, "46. A stock broker shall maintain unpaid securities");
    const b = computeClauseSimilarity(OLD_46_TEXT, "46. A stock broker shall maintain unpaid securities");
    expect(a).toBe(b);
  });

  it("ignores punctuation/case-only differences -> 1.0", () => {
    expect(computeClauseSimilarity("A, stock; broker.", "a stock broker")).toBe(1);
  });

  it("single-word change in a long (>=50 token) clause -> >= 0.98", () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`);
    const original = words.join(" ");
    const changed = [...words];
    changed[10] = "REPLACED";
    const score = computeClauseSimilarity(original, changed.join(" "));
    expect(score).toBeGreaterThanOrEqual(CLAUSE_SIMILARITY_UNCHANGED_THRESHOLD);
  });

  it("is monotonic: more shared tokens never decreases the score", () => {
    const base = "the quick brown fox";
    const fewerShared = computeClauseSimilarity(base, "the quick");
    const moreShared = computeClauseSimilarity(base, "the quick brown");
    expect(moreShared).toBeGreaterThanOrEqual(fewerShared);
  });
});

describe("stripAmendmentPreamble (FR-6)", () => {
  const cases: Array<[string, string]> = [
    ["Paragraph 46 is amended to read as follows: 'NEW TEXT'", "NEW TEXT"],
    ["Clause 3 shall read as follows: NEW TEXT", "NEW TEXT"],
    ["Clause 3 shall now read as under: NEW TEXT", "NEW TEXT"],
    ["Paragraph 5 shall be substituted by the following: NEW TEXT", "NEW TEXT"],
    ["Paragraph 5 is substituted by the following - NEW TEXT", "NEW TEXT"]
  ];
  for (const [input, expected] of cases) {
    it(`strips marker: ${input.slice(0, 40)}…`, () => {
      expect(stripAmendmentPreamble(input)).toBe(expected);
    });
  }

  it("returns null when no recognizable marker is present (must fall through)", () => {
    expect(stripAmendmentPreamble("This paragraph has no substitution marker whatsoever.")).toBeNull();
  });
});

describe("markerSplit (FR-7)", () => {
  it("splits two correctly-numbered segments matching two amendedParaRefs", () => {
    const text = "12. First replacement paragraph text.\n13. Second replacement paragraph text.";
    const result = markerSplit(text, ["12", "13"]);
    expect(result).not.toBeNull();
    expect(result!.get("12")).toContain("First replacement");
    expect(result!.get("13")).toContain("Second replacement");
  });

  it("returns null when segment count does not match amendedParaRefs", () => {
    const text = "12. Only one segment here.";
    expect(markerSplit(text, ["12", "13"])).toBeNull();
  });

  it("returns null when segment numbers do not match the claimed refs", () => {
    const text = "12. First.\n99. Mismatched number.";
    expect(markerSplit(text, ["12", "13"])).toBeNull();
  });

  it("returns null for an empty amendedParaRefs list", () => {
    expect(markerSplit("12. text", [])).toBeNull();
  });
});

describe("buildProcessTaskRedline (FR-21..FR-24)", () => {
  const p = proposal();

  it("oldTask null -> all 5 fields 'added', overallStatus 'new'", () => {
    const redline = buildProcessTaskRedline(null, null, mapping().processTaskDraft, p);
    expect(redline.fields).toHaveLength(5);
    expect(redline.fields.every((f) => f.status === "added")).toBe(true);
    expect(redline.oldTaskId).toBeNull();
    expect(redline.overallStatus).toBe("new");
  });

  it("produces exactly 5 fields in the fixed order", () => {
    const redline = buildProcessTaskRedline(oldTask(), oldObligation().obligation_id, mapping().processTaskDraft, p);
    expect(redline.fields.map((f) => f.field)).toEqual(["task_name", "owner_role", "sla_hours", "system_touchpoint", "risk_score"]);
  });

  it("marks changed/unchanged per field with strict numeric equality", () => {
    const redline = buildProcessTaskRedline(oldTask(), oldObligation().obligation_id, mapping().processTaskDraft, p);
    const byField = Object.fromEntries(redline.fields.map((f) => [f.field, f.status]));
    expect(byField.owner_role).toBe("unchanged"); // Compliance Officer == Compliance Officer
    expect(byField.system_touchpoint).toBe("unchanged");
    expect(byField.sla_hours).toBe("changed"); // 0 -> 24
    expect(byField.risk_score).toBe("changed"); // 0.3 -> 0.84
    expect(redline.overallStatus).toBe("modified");
  });

  it("degenerate case: modified obligation whose new task is field-identical still overallStatus 'modified' (FR-24)", () => {
    const identicalDraft: MappingRiskScoringResult["processTaskDraft"] = {
      obligation_id: oldTask().obligation_id,
      task_name: oldTask().task_name,
      owner_role: oldTask().owner_role,
      sla_hours: oldTask().sla_hours,
      system_touchpoint: oldTask().system_touchpoint,
      risk_score: oldTask().risk_score
    };
    const redline = buildProcessTaskRedline(oldTask(), oldObligation().obligation_id, identicalDraft, p);
    expect(redline.fields.every((f) => f.status === "unchanged")).toBe(true);
    expect(redline.overallStatus).toBe("modified");
  });
});

describe("classifyObligationDiffs (FR-9..FR-12, §8)", () => {
  const live = [{ obligation: oldObligation(), clause: oldClause46() }];

  function materialDiff(newText: string): ClauseTextDiff {
    return {
      paraRef: "46",
      oldClause: oldClause46(),
      newText,
      similarity: 0.15,
      alignmentMethod: "single_paragraph_direct",
      alignmentConfidence: 0.95,
      materiality: "material"
    };
  }

  it("material change with a usable proposal -> superseded", () => {
    const up: UpstreamClauseResult[] = [
      { clauseCandidate: clauseCandidate(AMEND_CLAUSE_ID, AMEND_CIRCULAR_ID, "1", "amended text ..."), extraction: extraction([proposal()]), mappingResults: [mapping()], contradictionFlags: [false] }
    ];
    const entries = classifyObligationDiffs([materialDiff("amended text ...")], live, up);
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("superseded");
    expect(entries[0].oldObligation?.obligation_id).toBe("obl-cuspa-old");
    expect(entries[0].newObligationProposal).not.toBeNull();
  });

  it("unchanged (cosmetic) materiality -> unaffected, still logged (FR-12)", () => {
    const diff: ClauseTextDiff = { ...materialDiff(OLD_46_TEXT), similarity: 0.99, materiality: "unchanged" };
    const entries = classifyObligationDiffs([diff], live, []);
    expect(entries[0].action).toBe("unaffected");
    expect(entries[0].rationale).toContain("cosmetic");
  });

  it("matchedText null (newText null) -> unaffected, not a repeal (FR-9)", () => {
    const diff: ClauseTextDiff = {
      paraRef: "46",
      oldClause: oldClause46(),
      newText: null,
      similarity: 1,
      alignmentMethod: "llm_aligned",
      alignmentConfidence: 0.9,
      materiality: "unchanged"
    };
    const entries = classifyObligationDiffs([diff], live, []);
    expect(entries[0].action).toBe("unaffected");
  });

  it("newly added paragraph (oldClause null) with proposal -> newly_added", () => {
    const diff: ClauseTextDiff = {
      paraRef: "46A",
      oldClause: null,
      newText: "46A. New reconciliation obligation text.",
      similarity: 0,
      alignmentMethod: "single_paragraph_direct",
      alignmentConfidence: 0.95,
      materiality: "material"
    };
    const up: UpstreamClauseResult[] = [
      { clauseCandidate: clauseCandidate(AMEND_CLAUSE_ID, AMEND_CIRCULAR_ID, "1", "46A. New reconciliation obligation text."), extraction: extraction([proposal()]), mappingResults: [mapping()], contradictionFlags: [false] }
    ];
    const entries = classifyObligationDiffs([diff], [], up);
    expect(entries[0].action).toBe("newly_added");
    expect(entries[0].oldObligation).toBeNull();
  });

  it("informational-only amended clause over an existing obligation -> repealed (§8)", () => {
    const up: UpstreamClauseResult[] = [
      { clauseCandidate: clauseCandidate(AMEND_CLAUSE_ID, AMEND_CIRCULAR_ID, "1", "Paragraph 46 is hereby deleted."), extraction: extraction([]), mappingResults: [], contradictionFlags: [] }
    ];
    const diff = materialDiff("Paragraph 46 is hereby deleted.");
    const entries = classifyObligationDiffs([diff], live, up);
    expect(entries[0].action).toBe("repealed");
    expect(entries[0].oldObligation?.obligation_id).toBe("obl-cuspa-old");
  });

  it("unresolved alignment -> unaffected audit entry, no supersession (AC4 support)", () => {
    const diff: ClauseTextDiff = {
      paraRef: "46",
      oldClause: oldClause46(),
      newText: "some low-confidence text",
      similarity: 0,
      alignmentMethod: "unresolved",
      alignmentConfidence: 0.4,
      materiality: "material"
    };
    const entries = classifyObligationDiffs([diff], live, []);
    expect(entries[0].action).toBe("unaffected");
    expect(entries[0].rationale).toContain("unresolved");
  });
});
