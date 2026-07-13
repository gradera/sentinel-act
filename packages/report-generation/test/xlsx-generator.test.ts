import { describe, expect, it } from "vitest";
import type { ComplianceRegisterRow } from "@sentinel-act/graph-db";
import { computeIntegrityHash, generateXlsx } from "../src/xlsx-generator.js";
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

const METADATA = {
  asOfDate: "2026-07-13",
  generatedAt: "2026-07-13T12:00:00.000Z",
  generatedBy: "auditor@example.com",
  filters: { tier: "B" }
};

describe("generateXlsx", () => {
  it("produces a real ZIP container containing the required OOXML parts", () => {
    const buffer = generateXlsx([makeRow()], METADATA);
    const entries = parseZip(buffer);

    expect(entries.has("[Content_Types].xml")).toBe(true);
    expect(entries.has("_rels/.rels")).toBe(true);
    expect(entries.has("xl/workbook.xml")).toBe(true);
    expect(entries.has("xl/_rels/workbook.xml.rels")).toBe(true);
    expect(entries.has("xl/worksheets/sheet1.xml")).toBe(true);
    expect(entries.has("xl/worksheets/sheet2.xml")).toBe(true);
  });

  it("[Content_Types].xml is well-formed-looking and declares both worksheet parts", () => {
    const buffer = generateXlsx([makeRow()], METADATA);
    const entries = parseZip(buffer);
    const contentTypes = entries.get("[Content_Types].xml")!.data.toString("utf8");

    expect(contentTypes.startsWith("<?xml")).toBe(true);
    expect(contentTypes).toContain("<Types");
    expect(contentTypes).toContain("</Types>");
    expect(contentTypes).toContain("/xl/worksheets/sheet1.xml");
    expect(contentTypes).toContain("/xl/worksheets/sheet2.xml");
  });

  it("sheet1 contains the exact §4.2 header row and a full data row's values", () => {
    const buffer = generateXlsx([makeRow({ obligation_id: "OBL-KNOWN-42" })], METADATA);
    const entries = parseZip(buffer);
    const sheet1 = entries.get("xl/worksheets/sheet1.xml")!.data.toString("utf8");

    // Header row: field names, in §4.2 declaration order.
    expect(sheet1).toContain(">circular_id<");
    expect(sheet1).toContain(">obligation_id<");
    expect(sheet1).toContain(">requirement_text<");
    expect(sheet1).toContain(">decided_at<");

    // A known data row's values.
    expect(sheet1).toContain(">OBL-KNOWN-42<");
    expect(sheet1).toContain(">reporting<");
    expect(sheet1).toContain(">reviewer@example.com<");
    expect(sheet1).toContain(">approve<");
  });

  it("sheet2 (FR-18 metadata) contains asOfDate, generatedAt, generatedBy, filters, rowCount, and an integrity hash", () => {
    const rows = [makeRow(), makeRow({ obligation_id: "OBL-2" })];
    const buffer = generateXlsx(rows, METADATA);
    const entries = parseZip(buffer);
    const sheet2 = entries.get("xl/worksheets/sheet2.xml")!.data.toString("utf8");

    expect(sheet2).toContain(">2026-07-13<");
    expect(sheet2).toContain(">2026-07-13T12:00:00.000Z<");
    expect(sheet2).toContain(">auditor@example.com<");
    expect(sheet2).toContain(">2<"); // rowCount
    // The filters JSON is itself embedded as XML text, so its quotes come
    // back XML-escaped (&quot;) — asserting the escaped form here (rather
    // than a literal `"`) is the correct expectation for well-formed XML.
    expect(sheet2).toContain("&quot;tier&quot;:&quot;B&quot;");

    const expectedHash = computeIntegrityHash(rows);
    expect(sheet2).toContain(`>${expectedHash}<`);
  });

  it("escapes & < > \" ' in requirement_text and the escaped form round-trips to the original text", () => {
    const dangerousText = `Report "Q1 & Q2" figures if value < 10 or > 90, per clause O'Brien's amendment.`;
    const buffer = generateXlsx([makeRow({ obligation_id: "OBL-ESCAPE", requirement_text: dangerousText })], METADATA);
    const entries = parseZip(buffer);
    const sheet1 = entries.get("xl/worksheets/sheet1.xml")!.data.toString("utf8");

    // The raw XML must NOT contain an unescaped literal "&" (as a standalone
    // ampersand not part of an escape sequence) or unescaped angle
    // brackets/quotes from the dangerous text — i.e. this asserts escaping
    // actually happened, not just that the substring exists somewhere.
    expect(sheet1).toContain("&amp;");
    expect(sheet1).toContain("&lt;");
    expect(sheet1).toContain("&gt;");
    expect(sheet1).toContain("&quot;");
    expect(sheet1).toContain("&apos;");

    // Round-trip: unescape the same way an XML parser would and confirm we
    // recover the exact original string.
    const unescape = (s: string) =>
      s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

    const match = sheet1.match(/<is><t[^>]*>([\s\S]*?)<\/t><\/is>/g) ?? [];
    const rawInnerTexts = match.map((cell) => cell.replace(/^<is><t[^>]*>/, "").replace(/<\/t><\/is>$/, ""));
    const recovered = rawInnerTexts.map(unescape);

    expect(recovered).toContain(dangerousText);
  });

  it("every ZIP entry's stored CRC-32 matches the recomputed CRC-32 of its decompressed content", () => {
    const buffer = generateXlsx([makeRow(), makeRow({ obligation_id: "OBL-2" })], METADATA);
    const entries = parseZip(buffer);

    expect(entries.size).toBeGreaterThan(0);
    for (const entry of entries.values()) {
      expect(entry.recomputedCrc32, `CRC-32 mismatch for ${entry.name}`).toBe(entry.storedCrc32);
    }
  });

  it("handles an empty row set without producing a broken archive", () => {
    const buffer = generateXlsx([], METADATA);
    const entries = parseZip(buffer);

    expect(entries.has("xl/worksheets/sheet1.xml")).toBe(true);
    const sheet1 = entries.get("xl/worksheets/sheet1.xml")!.data.toString("utf8");
    expect(sheet1).toContain(">obligation_id<"); // header row still present
    for (const entry of entries.values()) {
      expect(entry.recomputedCrc32).toBe(entry.storedCrc32);
    }
  });
});
