// Hand-rolled OOXML .xlsx writer — Spec 10 §4.2 (exact column set),
// §5.6 (generateComplianceRegisterXlsx signature), FR-18 (metadata/
// integrity-stamp requirement), §13 Open Question 10 (SHA-256 integrity
// stamp recommendation). Zero runtime dependencies: see README.md for why
// `exceljs` (the spec's own recommendation) could not be used in this
// environment and what was substituted instead.
//
// An .xlsx file is a ZIP archive (built by zip-writer.ts) containing a
// fixed set of XML parts (the OOXML SpreadsheetML format). This module
// writes the minimal set of parts a real reader (Excel, LibreOffice, and
// this package's own round-trip test) needs to open a genuinely valid
// two-sheet workbook:
//
//   [Content_Types].xml        — declares every part's MIME type
//   _rels/.rels                 — package-level relationship: which part is
//                                 the workbook
//   xl/workbook.xml             — declares the two sheets
//   xl/_rels/workbook.xml.rels  — maps each <sheet r:id="..."> to its
//                                 worksheets/sheetN.xml part
//   xl/worksheets/sheet1.xml    — the Compliance Register data (§4.2's
//                                 exact ComplianceRegisterRow column set)
//   xl/worksheets/sheet2.xml    — the FR-18 metadata sheet
//
// Simplification (documented, not a correctness gap): every string cell
// uses an INLINE string (`t="inlineStr"`, `<is><t>...</t></is>`) rather
// than the more common shared-strings-table (`xl/sharedStrings.xml`)
// indirection. Inline strings are valid OOXML and every reader that opens
// XLSX at all supports them — the shared-strings table exists purely as a
// file-size optimization for workbooks with many repeated strings, which
// is irrelevant here and would only add another part + another set of
// relationships to get right for no behavioral benefit.
import type { ComplianceRegisterRow } from "@sentinel-act/graph-db";
import { computeIntegrityHash, REGISTER_COLUMNS } from "./integrity-hash.js";
import { buildZip } from "./zip-writer.js";

// computeIntegrityHash/serializeRowsForHash now live in ./integrity-hash.ts
// (shared with pdf-generator.ts, see that module's top-of-file comment for
// why splitting this out matters — both generators must produce an
// IDENTICAL hash for the same dataset). Re-exported here unchanged so
// existing imports of `computeIntegrityHash`/`serializeRowsForHash` from
// "./xlsx-generator.js" (this package's own index.ts, this file's own
// test suite) keep working without modification.
export { computeIntegrityHash, serializeRowsForHash } from "./integrity-hash.js";

export interface XlsxMetadata {
  asOfDate: string;
  generatedAt: string;
  generatedBy: string;
  filters: unknown;
}

// ---------------------------------------------------------------------------
// XML escaping — every cell value that can contain arbitrary text (most
// notably `requirement_text`, free-form regulatory prose that WILL contain
// `&`, `<`, `>`, quotes) must be escaped before being embedded in XML, or
// the resulting part is not well-formed and the whole archive becomes an
// unopenable "corrupt file" rather than a valid XLSX. Order matters: `&`
// must be escaped first, or the escape sequences produced for the other
// four characters would themselves get their `&` re-escaped.
// ---------------------------------------------------------------------------

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// §4.2's exact column set (one column per ComplianceRegisterRow field, in
// the same order the interface declares them) now lives in
// ./integrity-hash.ts, imported above — it doubles as both this sheet's
// header/cell order AND the integrity hash's canonical column order, so
// there is exactly one list in the whole package, not two that could drift.

// Numeric ComplianceRegisterRow fields get a numeric (unquoted `<v>`) cell;
// everything else is treated as a string (inline string cell). Listed
// explicitly rather than inferred at runtime from a row's typeof value, so
// a column's cell type is stable even if every row happens to have `null`
// in it (an empty column should still count as "the numeric column", not
// silently degrade to string typing).
const NUMERIC_COLUMNS = new Set<keyof ComplianceRegisterRow>(["confidence_score", "grounding_score", "sla_hours", "risk_score"]);

/** Converts a 0-based column index to a spreadsheet column letter
 *  (0 -> "A", 25 -> "Z", 26 -> "AA", ...). Standard bijective base-26
 *  conversion — needed because every `<c r="...">` cell reference in
 *  SpreadsheetML XML is letter+number (e.g. "C7"), not a raw index. */
function columnLetter(index: number): string {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function cellRef(colIndex: number, rowNumber: number): string {
  return `${columnLetter(colIndex)}${rowNumber}`;
}

/** Renders one `<c>` cell element, or an empty string (no cell at all —
 *  valid OOXML for "blank") when the value is null/undefined. Numeric
 *  cells omit the `t` attribute (SpreadsheetML's default cell type is
 *  numeric); string cells use `t="inlineStr"` per this file's documented
 *  simplification above. */
function renderCell(colIndex: number, rowNumber: number, value: string | number | null, isNumeric: boolean): string {
  if (value === null) {
    return "";
  }
  const ref = cellRef(colIndex, rowNumber);
  if (isNumeric) {
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(value))}</t></is></c>`;
}

function renderRegisterRowXml(row: ComplianceRegisterRow, rowNumber: number): string {
  const cells = REGISTER_COLUMNS.map((key, colIndex) => {
    const value = row[key] as string | number | null;
    return renderCell(colIndex, rowNumber, value, NUMERIC_COLUMNS.has(key));
  }).join("");
  return `<row r="${rowNumber}">${cells}</row>`;
}

function renderHeaderRowXml(): string {
  const cells = REGISTER_COLUMNS.map((key, colIndex) => renderCell(colIndex, 1, key, false)).join("");
  return `<row r="1">${cells}</row>`;
}

function buildSheet1Xml(rows: ComplianceRegisterRow[]): string {
  const headerRow = renderHeaderRowXml();
  const dataRows = rows.map((row, i) => renderRegisterRowXml(row, i + 2)).join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${headerRow}${dataRows}</sheetData>` +
    `</worksheet>`
  );
}

// ---------------------------------------------------------------------------
// FR-18 metadata sheet: generation timestamp, asOfDate, filters applied,
// row count, requester (generatedBy), and — per §13 Open Question 10's
// recommended default — a SHA-256 integrity hash of the serialized
// dataset (computeIntegrityHash, imported from ./integrity-hash.ts), so a
// recipient can independently verify the file's row data hasn't been
// altered after export without needing the Hash-chained Audit Ledger
// (Spec 07) to exist yet.
// ---------------------------------------------------------------------------

function metadataRowXml(rowNumber: number, label: string, value: string): string {
  const labelCell = renderCell(0, rowNumber, label, false);
  const valueCell = renderCell(1, rowNumber, value, false);
  return `<row r="${rowNumber}">${labelCell}${valueCell}</row>`;
}

function buildSheet2Xml(rows: ComplianceRegisterRow[], metadata: XlsxMetadata): string {
  const integrityHash = computeIntegrityHash(rows);
  const filtersJson = JSON.stringify(metadata.filters ?? null);

  const entries: Array<[string, string]> = [
    ["asOfDate", metadata.asOfDate],
    ["generatedAt", metadata.generatedAt],
    ["generatedBy", metadata.generatedBy],
    ["filters", filtersJson],
    ["rowCount", String(rows.length)],
    ["integritySha256", integrityHash]
  ];

  const headerRow = `<row r="1">${renderCell(0, 1, "field", false)}${renderCell(1, 1, "value", false)}</row>`;
  const dataRows = entries.map(([label, value], i) => metadataRowXml(i + 2, label, value)).join("");

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${headerRow}${dataRows}</sheetData>` +
    `</worksheet>`
  );
}

// ---------------------------------------------------------------------------
// Fixed OOXML package parts (workbook wiring + package-level relationships
// + content types). None of these vary per export — they only ever
// describe "there are two worksheets, here's how to find them."
// ---------------------------------------------------------------------------

const CONTENT_TYPES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
  `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
  `<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
  `</Types>`;

const PACKAGE_RELS_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
  `</Relationships>`;

const WORKBOOK_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
  `<sheets>` +
  `<sheet name="Compliance Register" sheetId="1" r:id="rId1"/>` +
  `<sheet name="Metadata" sheetId="2" r:id="rId2"/>` +
  `</sheets>` +
  `</workbook>`;

const WORKBOOK_RELS_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
  `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>` +
  `</Relationships>`;

/** Generates a complete, valid .xlsx file (as a Buffer) for the Compliance
 *  Register Export: sheet1 is the §4.2 column set (one row per
 *  ComplianceRegisterRow), sheet2 is the FR-18 metadata sheet (asOfDate,
 *  generatedAt, generatedBy, filters, rowCount, and a SHA-256 integrity
 *  hash of the row data per §13 Open Question 10). Pure function — no I/O,
 *  matching Spec 10 §5.6's "no Next.js, no Neo4j driver, no filesystem
 *  access inside the package" constraint (the spec's own signature
 *  declares this `Promise<Buffer>`; this implementation returns `Buffer`
 *  synchronously since nothing here is actually asynchronous — a caller
 *  that needs a Promise can trivially `await` a synchronous value, so this
 *  is a strict widening, not a breaking deviation). */
export function generateXlsx(rows: ComplianceRegisterRow[], metadata: XlsxMetadata): Buffer {
  const sheet1Xml = buildSheet1Xml(rows);
  const sheet2Xml = buildSheet2Xml(rows, metadata);

  return buildZip([
    { name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES_XML, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(PACKAGE_RELS_XML, "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(WORKBOOK_XML, "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(WORKBOOK_RELS_XML, "utf8") },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheet1Xml, "utf8") },
    { name: "xl/worksheets/sheet2.xml", data: Buffer.from(sheet2Xml, "utf8") }
  ]);
}
