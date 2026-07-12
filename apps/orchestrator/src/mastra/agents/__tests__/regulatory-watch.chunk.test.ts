// Spec 02 §10 unit test: chunkIntoClauses, table-driven over numbering
// patterns (FR-20/FR-21).
import { describe, expect, it } from "vitest";
import { chunkIntoClauses } from "../regulatory-watch.agent.js";

const CIRCULAR_ID = "circ-test-1";
const DATE_EFFECTIVE = "2026-07-01";

describe("chunkIntoClauses", () => {
  const cases: Array<{ name: string; text: string; expectedParaRefs: string[] }> = [
    {
      name: "plain numeric numbering (1., 2.)",
      text: "1. First obligation text.\n2. Second obligation text.",
      expectedParaRefs: ["1", "2"]
    },
    {
      name: "nested numeric numbering (3.2)",
      text: "3. Top-level obligation.\n3.1 Sub-obligation one.\n3.2 Sub-obligation two.",
      expectedParaRefs: ["3", "3.1", "3.2"]
    },
    {
      name: "lettered sub-clauses (a))",
      text: "a) First item.\nb) Second item.",
      expectedParaRefs: ["a", "b"]
    },
    {
      name: "roman numeral numbering (i.)",
      text: "i. First point.\nii. Second point.",
      expectedParaRefs: ["i", "ii"]
    },
    {
      name: "nested paragraph+sub-clause reference (46(a))",
      text: "46(a) First nested item.\n46(b) Second nested item.",
      expectedParaRefs: ["46(a)", "46(b)"]
    }
  ];

  for (const testCase of cases) {
    it(`splits ${testCase.name}`, () => {
      const clauses = chunkIntoClauses(testCase.text, CIRCULAR_ID, DATE_EFFECTIVE);
      expect(clauses.map((c) => c.para_ref)).toEqual(testCase.expectedParaRefs);
    });
  }

  it("captures preamble text before the first numbering token (FR-21)", () => {
    const text = "In exercise of powers conferred by the Act, SEBI issues this circular.\n1. First obligation.";
    const clauses = chunkIntoClauses(text, CIRCULAR_ID, DATE_EFFECTIVE);
    expect(clauses[0].para_ref).toBe("preamble");
    expect(clauses[0].text).toContain("In exercise of powers conferred");
    expect(clauses[1].para_ref).toBe("1");
  });

  it("produces a single preamble clause when no numbering token is present at all", () => {
    const text = "This document has no numbered paragraphs whatsoever, only prose.";
    const clauses = chunkIntoClauses(text, CIRCULAR_ID, DATE_EFFECTIVE);
    expect(clauses).toHaveLength(1);
    expect(clauses[0].para_ref).toBe("preamble");
  });

  it("omits the preamble clause entirely when the text starts directly with a numbering token", () => {
    const text = "1. First obligation.\n2. Second obligation.";
    const clauses = chunkIntoClauses(text, CIRCULAR_ID, DATE_EFFECTIVE);
    expect(clauses.every((c) => c.para_ref !== "preamble")).toBe(true);
  });

  it("is deterministic given identical input (FR-15): same para_ref values, same ordering", () => {
    const text = "1. First.\n2. Second.\n3.2 Nested.";
    const first = chunkIntoClauses(text, CIRCULAR_ID, DATE_EFFECTIVE);
    const second = chunkIntoClauses(text, CIRCULAR_ID, DATE_EFFECTIVE);
    expect(first.map((c) => c.para_ref)).toEqual(second.map((c) => c.para_ref));
    expect(first.map((c) => c.text)).toEqual(second.map((c) => c.text));
  });

  it("sets circular_id, valid_from from dateEffective, valid_to null, embedding_ref/recorded_at placeholders (FR-23)", () => {
    const [clause] = chunkIntoClauses("1. First.", CIRCULAR_ID, DATE_EFFECTIVE);
    expect(clause.circular_id).toBe(CIRCULAR_ID);
    expect(clause.valid_from).toBe(DATE_EFFECTIVE);
    expect(clause.valid_to).toBeNull();
    expect(clause.embedding_ref).toBe("");
    expect(clause.recorded_at).toBeNull();
    expect(clause.clause_id).toBeTruthy();
  });
});
