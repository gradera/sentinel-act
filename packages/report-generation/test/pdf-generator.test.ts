import { describe, expect, it } from "vitest";
import type { ComplianceRegisterRow } from "@sentinel-act/graph-db";
import { computeIntegrityHash } from "../src/integrity-hash.js";
import { escapePdfText, generatePdf, wrapText, type PdfMetadata } from "../src/pdf-generator.js";
import { generateXlsx } from "../src/xlsx-generator.js";
import { parsePdf } from "./pdf-test-utils.js";
import { parseZip } from "./zip-test-utils.js";

function makeRow(overrides: Partial<ComplianceRegisterRow> = {}): ComplianceRegisterRow {
  return {
    circular_id: "CIRC-1",
    circular_title: "Sample Circular",
    circular_date_issued: "2025-12-01",
    circular_date_effective: "2026-01-01",
    clause_para_ref: "12",
    obligation_id: "OBL-1",
    obligation_category: "reporting",
    requirement_text: "File the quarterly report within 30 days.",
    deadline_rule: "30 days from quarter end",
    responsible_role: "Compliance Officer",
    penalty_ref: null,
    obligation_status: "committed",
    confidence_score: 0.9,
    grounding_score: 0.85,
    task_id: "TASK-1",
    task_name: "Prepare filing",
    owner_role: "Ops",
    sla_hours: 24,
    system_touchpoint: "filing-portal",
    risk_score: 0.4,
    review_id: "REV-1",
    reviewer_id: "reviewer@example.com",
    review_tier: "B",
    decision: "approve",
    rationale: "Looks correct.",
    decided_at: "2026-01-05T00:00:00.000Z",
    ...overrides
  };
}

const METADATA: PdfMetadata = {
  asOfDate: "2026-07-13",
  generatedAt: "2026-07-13T12:00:00.000Z",
  generatedBy: "auditor@example.com",
  filters: { tier: "B" }
};

describe("generatePdf — structural validity", () => {
  it("starts with the PDF header and ends with %%EOF", () => {
    const buffer = generatePdf([makeRow()], METADATA);
    const text = buffer.toString("latin1");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(/%%EOF\s*$/.test(text)).toBe(true);
  });

  it("startxref points to a byte offset that lands exactly on the literal 'xref' keyword", () => {
    const buffer = generatePdf([makeRow()], METADATA);
    const parsed = parsePdf(buffer);
    const atOffset = parsed.text.slice(parsed.startxrefOffset, parsed.startxrefOffset + 4);
    expect(atOffset).toBe("xref");
  });

  it("has matching obj/endobj pairs, and the count equals the trailer's declared Size - 1", () => {
    const buffer = generatePdf([makeRow(), makeRow({ obligation_id: "OBL-2" })], METADATA);
    const text = buffer.toString("latin1");
    const objCount = (text.match(/\d+ 0 obj\n/g) ?? []).length;
    const endobjCount = (text.match(/endobj\n/g) ?? []).length;
    expect(objCount).toBe(endobjCount);

    const parsed = parsePdf(buffer);
    expect(parsed.objectNumbersInOrder.length).toBe(objCount);
    expect(parsed.trailerSize - 1).toBe(objCount);
  });

  it("Catalog -> Pages -> Kids resolves, and Kids length matches /Count", () => {
    const buffer = generatePdf([makeRow()], METADATA);
    const parsed = parsePdf(buffer);
    expect(parsed.pageObjNums.length).toBe(parsed.pagesCount);
    expect(parsed.pageObjNums.length).toBeGreaterThan(0);
  });

  it("every Page object resolves to a real content stream (decompressed/plain-text, per this package's simplification)", () => {
    const buffer = generatePdf([makeRow()], METADATA);
    const parsed = parsePdf(buffer);
    for (const content of parsed.pageContents) {
      expect(content).toContain("BT");
      expect(content).toContain("ET");
      expect(content).toContain("/F1");
    }
  });
});

describe("generatePdf — cover / FR-18 metadata page content", () => {
  it("page 1 contains asOfDate, generatedAt, generatedBy, rowCount, and the integrity hash", () => {
    const rows = [makeRow(), makeRow({ obligation_id: "OBL-2" })];
    const buffer = generatePdf(rows, METADATA);
    const parsed = parsePdf(buffer);
    const coverContent = parsed.pageContents[0];

    expect(coverContent).toContain("2026-07-13");
    expect(coverContent).toContain("2026-07-13T12:00:00.000Z");
    expect(coverContent).toContain("auditor@example.com");
    expect(coverContent).toContain("Row count: 2");

    const expectedHash = computeIntegrityHash(rows);
    expect(coverContent).toContain(expectedHash);
  });

  it("renders filters as readable text, not raw JSON", () => {
    const buffer = generatePdf([makeRow()], METADATA);
    const parsed = parsePdf(buffer);
    const coverContent = parsed.pageContents[0];

    // Readable "Label: value" form, not `{"tier":"B"}`.
    expect(coverContent).toContain("Tier: B");
    expect(coverContent).not.toContain("{");
    expect(coverContent).not.toContain("}");
  });

  it("a null filters object renders as an explicit 'no filters applied' statement", () => {
    const buffer = generatePdf([makeRow()], { ...METADATA, filters: null });
    const parsed = parsePdf(buffer);
    // Parens are backslash-escaped in the raw content stream (PDF string
    // literal rule — see escapePdfText) — assert the escaped form, the
    // same convention xlsx-generator.test.ts asserts for its own escaping
    // (there: XML-escaped `&quot;`, here: backslash-escaped parens).
    expect(parsed.pageContents[0]).toContain("None \\(no filters applied\\)");
  });
});

describe("generatePdf — grouped-by-Obligation content", () => {
  it("a known obligation_id and reviewer_id both appear in the content pages", () => {
    const rows = [makeRow({ obligation_id: "OBL-KNOWN-42", reviewer_id: "known-reviewer@example.com" })];
    const buffer = generatePdf(rows, METADATA);
    const parsed = parsePdf(buffer);
    const contentPages = parsed.pageContents.slice(1).join("\n");

    expect(contentPages).toContain("OBL-KNOWN-42");
    expect(contentPages).toContain("known-reviewer@example.com");
  });

  it("a genuine Tier A row (no review, auto-committed) renders 'Auto-committed (Tier A)'", () => {
    const rows = [
      makeRow({
        obligation_id: "OBL-TIER-A",
        review_id: null,
        reviewer_id: null,
        review_tier: "A",
        decision: "auto-committed",
        rationale: null,
        decided_at: null
      })
    ];
    const buffer = generatePdf(rows, METADATA);
    const parsed = parsePdf(buffer);
    const contentPages = parsed.pageContents.slice(1).join("\n");

    expect(contentPages).toContain("Auto-committed");
    expect(contentPages).toContain("Tier A");
  });

  it("an obligation with no review yet (not Tier A) renders a pending statement, not auto-committed", () => {
    const rows = [
      makeRow({
        obligation_id: "OBL-PENDING",
        review_id: null,
        reviewer_id: null,
        review_tier: null,
        decision: null,
        rationale: null,
        decided_at: null
      })
    ];
    const buffer = generatePdf(rows, METADATA);
    const parsed = parsePdf(buffer);
    const contentPages = parsed.pageContents.slice(1).join("\n");

    expect(contentPages).toContain("No human review recorded yet");
  });

  it("de-duplicates tasks/reviews within an obligation's cross-joined rows (no repeated listing)", () => {
    // Two ComplianceRegisterRows for the same obligation, same single
    // task and single review (the shape a 1-task x 1-review obligation
    // would never actually produce more than one row for — but this
    // simulates the FR-15 cross-product duplicating a task's ID across
    // rows, which grouping must collapse via task_id/review_id keys).
    const rows = [
      makeRow({ obligation_id: "OBL-DEDUPE", task_id: "TASK-X", review_id: "REV-X" }),
      makeRow({ obligation_id: "OBL-DEDUPE", task_id: "TASK-X", review_id: "REV-X" })
    ];
    const buffer = generatePdf(rows, METADATA);
    const parsed = parsePdf(buffer);
    const contentPages = parsed.pageContents.slice(1).join("\n");

    const taskOccurrences = contentPages.split("TASK-X").length - 1;
    expect(taskOccurrences).toBe(1);
  });

  it("handles an empty row set with an explicit 'no records' statement rather than a blank/broken page", () => {
    const buffer = generatePdf([], METADATA);
    const parsed = parsePdf(buffer);
    const contentPages = parsed.pageContents.slice(1).join("\n");
    expect(contentPages).toContain("No Obligation records match");
  });
});

describe("generatePdf — string escaping", () => {
  it("escapes literal ( ) and \\ inside a PDF string literal, and the escaped form recovers the original via a simple unescape", () => {
    const dangerousRationale = `Rejected: value (was "9") does not match \\config\\ path, see (Annex B).`;
    const rows = [makeRow({ obligation_id: "OBL-ESCAPE", rationale: dangerousRationale })];
    const buffer = generatePdf(rows, METADATA);
    const parsed = parsePdf(buffer);
    const contentPages = parsed.pageContents.slice(1).join("\n");

    // The raw content stream must contain backslash-escaped parens/backslash,
    // not the bare characters (which would break the Tj string literal).
    expect(contentPages).toContain("\\(Annex B\\)");
    expect(contentPages).toContain("\\\\config\\\\");

    // Round-trip: a minimal unescape (the inverse of escapePdfText's
    // backslash-escaping — ? substitution for non-Latin1/control chars is
    // intentionally lossy and not reversed here) recovers the dangerous
    // text's parens/backslashes.
    const unescape = (s: string) => s.replace(/\\([\\()])/g, "$1");
    const recovered = unescape(contentPages);
    expect(recovered).toContain("(Annex B)");
    expect(recovered).toContain("\\config\\");
  });

  it("escapePdfText escapes backslash/parens directly", () => {
    expect(escapePdfText("a(b)c\\d")).toBe("a\\(b\\)c\\\\d");
  });

  it("escapePdfText transliterates non-Latin1 code points to '?'", () => {
    expect(escapePdfText("café")).toBe("café"); // é (U+00E9) is within Latin-1, kept as-is
    expect(escapePdfText("中文")).toBe("??"); // CJK characters, outside Latin-1, transliterated
  });
});

describe("wrapText — fixed-chars-per-line wrapping", () => {
  it("wraps long text at the given character budget without splitting words mid-word when possible", () => {
    const longText =
      "This is a long requirement_text sentence that must be wrapped across several lines because it exceeds the configured character budget for a single line on the page.";
    const lines = wrapText(longText, 40);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
    expect(lines.join(" ").replace(/\s+/g, " ")).toBe(longText.replace(/\s+/g, " "));
  });

  it("hard-splits a single token longer than the character budget", () => {
    const longToken = "A".repeat(120);
    const lines = wrapText(longToken, 40);
    expect(lines.length).toBe(3);
    expect(lines.join("")).toBe(longToken);
  });
});

describe("generatePdf — pagination", () => {
  it("a large row set (100+ obligations) triggers multi-page pagination: /Pages Count > 1 and Kids length matches", () => {
    const rows: ComplianceRegisterRow[] = Array.from({ length: 120 }, (_, i) =>
      makeRow({
        obligation_id: `OBL-BULK-${i}`,
        reviewer_id: `reviewer-${i}@example.com`,
        requirement_text: `Synthetic bulk requirement number ${i} for pagination testing, long enough to wrap across a couple of lines on its own.`
      })
    );
    const buffer = generatePdf(rows, METADATA);
    const parsed = parsePdf(buffer);

    expect(parsed.pagesCount).toBeGreaterThan(1);
    expect(parsed.pageObjNums.length).toBe(parsed.pagesCount);

    // Spot-check: a known obligation from deep in the set is actually present
    // somewhere in the content pages (i.e. pagination didn't drop it).
    const allContent = parsed.pageContents.join("\n");
    expect(allContent).toContain("OBL-BULK-119");
    expect(allContent).toContain("reviewer-119@example.com");
  });

  it("a single small row set stays within a small, bounded page count (cover page + one content page)", () => {
    const buffer = generatePdf([makeRow()], METADATA);
    const parsed = parsePdf(buffer);
    expect(parsed.pagesCount).toBe(2);
  });
});

describe("generatePdf and generateXlsx — cross-format integrity hash equality", () => {
  it("embed the IDENTICAL SHA-256 integrity hash for the same dataset (both call the shared ./integrity-hash.ts function)", () => {
    const rows = [makeRow(), makeRow({ obligation_id: "OBL-2", reviewer_id: "second-reviewer@example.com" })];

    // Standalone reference value, computed independently of either
    // generator's own internals.
    const referenceHash = computeIntegrityHash(rows);

    // Extract the hash actually embedded in the PDF's cover page.
    const pdfBuffer = generatePdf(rows, METADATA);
    const pdfParsed = parsePdf(pdfBuffer);
    expect(pdfParsed.pageContents[0]).toContain(referenceHash);

    // Extract the hash actually embedded in the XLSX's metadata sheet
    // (sheet2), by parsing the ZIP container the same way
    // xlsx-generator.test.ts does.
    const xlsxBuffer = generateXlsx(rows, METADATA);
    const xlsxEntries = parseZip(xlsxBuffer);
    const sheet2 = xlsxEntries.get("xl/worksheets/sheet2.xml")!.data.toString("utf8");
    expect(sheet2).toContain(`>${referenceHash}<`);

    // Both embedded hashes equal the same standalone reference value, so
    // by transitivity they equal each other — this is the concrete,
    // reproduced proof that the two export formats of the SAME dataset
    // produce an IDENTICAL integrity stamp, not merely "structurally
    // guaranteed to" by sharing a function.
  });
});
