// assistant-query-templates.test.ts (Spec 12 §10): static-analysis test —
// asserts every template's cypher string, case-insensitively, contains none
// of CREATE, MERGE, SET , DELETE, DETACH, CALL apoc. (word-boundary matched
// to avoid false positives like a property named created_at) — this is the
// automated backstop for FR-7/NFR-4, not just review discipline. Also
// covers the five templates' shapes and the T2/T5 Tier C/ESCALATE
// independence guard (see file-level doc comment in the source file).
import { describe, expect, it } from "vitest";
import {
  ASSISTANT_QUERY_TEMPLATES,
  circularByIdOrTitleTemplate,
  findAssistantQueryTemplate,
  obligationByIdWithLineageTemplate,
  obligationsByCategoryAndDateRangeTemplate,
  obligationsByStatusTemplate,
  reviewsByCategoryAndDateRangeTemplate
} from "../../src/queries/assistant-query-templates.js";

// Word-boundary matched so `created_at`/`recorded_at` don't false-positive
// on "CREATE"; "SET " (trailing space) so `system_touchpoint`-style
// properties don't false-positive on "SET".
const WRITE_KEYWORD_PATTERNS: RegExp[] = [
  /\bCREATE\b/i,
  /\bMERGE\b/i,
  /\bSET\s/i,
  /\bDELETE\b/i,
  /\bDETACH\b/i,
  /\bCALL\s+apoc\./i
];

describe("ASSISTANT_QUERY_TEMPLATES — no write keywords (FR-7, NFR-4)", () => {
  it.each(ASSISTANT_QUERY_TEMPLATES.map((template) => [template.id, template.cypher] as const))(
    "%s contains no write-capable Cypher keyword",
    (_id, cypher) => {
      for (const pattern of WRITE_KEYWORD_PATTERNS) {
        expect(cypher).not.toMatch(pattern);
      }
    }
  );

  it("has exactly five templates", () => {
    expect(ASSISTANT_QUERY_TEMPLATES).toHaveLength(5);
  });
});

describe("findAssistantQueryTemplate", () => {
  it("returns the matching template by id", () => {
    expect(findAssistantQueryTemplate("obligations_by_status")).toBe(obligationsByStatusTemplate);
  });

  it("returns undefined for an unknown id", () => {
    expect(findAssistantQueryTemplate("not_a_real_template")).toBeUndefined();
  });
});

describe("template param schemas", () => {
  it("T1 requires categoryName, dateFrom, dateTo and defaults limit to 20, capped at 50", () => {
    const parsed = obligationsByCategoryAndDateRangeTemplate.paramsSchema.parse({
      categoryName: "Stockbroker",
      dateFrom: "2026-06-01",
      dateTo: "2026-07-31"
    });
    expect(parsed).toMatchObject({ categoryName: "Stockbroker", limit: 20 });
    expect(() => obligationsByCategoryAndDateRangeTemplate.paramsSchema.parse({ categoryName: "Stockbroker", dateFrom: "x", dateTo: "y", limit: 51 })).toThrow();
  });

  it("T2 requires a UUID obligationId", () => {
    expect(() => obligationByIdWithLineageTemplate.paramsSchema.parse({ obligationId: "not-a-uuid" })).toThrow();
    expect(
      obligationByIdWithLineageTemplate.paramsSchema.parse({ obligationId: "3fa85f64-5717-4562-b3fc-2c963f66afa6" })
    ).toEqual({ obligationId: "3fa85f64-5717-4562-b3fc-2c963f66afa6" });
  });

  it("T3 requires at least one of circularId/titleContains", () => {
    expect(() => circularByIdOrTitleTemplate.paramsSchema.parse({ circularId: null, titleContains: null })).toThrow();
    expect(
      circularByIdOrTitleTemplate.paramsSchema.parse({ circularId: null, titleContains: "CUSPA" })
    ).toMatchObject({ titleContains: "CUSPA" });
  });

  it("T4 restricts status to the seven canonical ObligationStatus values", () => {
    expect(() => obligationsByStatusTemplate.paramsSchema.parse({ status: "not_a_status" })).toThrow();
    expect(obligationsByStatusTemplate.paramsSchema.parse({ status: "tier_c_review" })).toMatchObject({
      status: "tier_c_review",
      limit: 20
    });
  });

  it("T5 allows a null decision (no filter) or approve/reject", () => {
    expect(() =>
      reviewsByCategoryAndDateRangeTemplate.paramsSchema.parse({
        categoryName: "Stockbroker",
        dateFrom: "2026-06-01T00:00:00Z",
        dateTo: "2026-07-31T23:59:59Z",
        decision: "invalid"
      })
    ).toThrow();
    expect(
      reviewsByCategoryAndDateRangeTemplate.paramsSchema.parse({
        categoryName: "Stockbroker",
        dateFrom: "2026-06-01T00:00:00Z",
        dateTo: "2026-07-31T23:59:59Z",
        decision: null
      })
    ).toMatchObject({ decision: null, limit: 20 });
  });
});

describe("Tier C / ESCALATE independence guard (cross-spec coordination notes)", () => {
  it("T2's OPTIONAL MATCH on HumanReview carries the guard", () => {
    expect(obligationByIdWithLineageTemplate.cypher).toContain(
      'NOT (hr.tier = "C" AND o.status IN ["tier_c_review", "escalated"])'
    );
  });

  it("T5's MATCH on HumanReview carries the guard", () => {
    expect(reviewsByCategoryAndDateRangeTemplate.cypher).toContain(
      'NOT (hr.tier = "C" AND o.status IN ["tier_c_review", "escalated"])'
    );
  });

  it("T1/T3/T4 don't return HumanReview at all, so they don't need the guard", () => {
    for (const template of [obligationsByCategoryAndDateRangeTemplate, circularByIdOrTitleTemplate, obligationsByStatusTemplate]) {
      expect(template.cypher).not.toContain("HumanReview");
    }
  });
});
