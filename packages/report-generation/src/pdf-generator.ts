// Hand-rolled PDF 1.4 writer — Spec 10 §5.6 (generateComplianceRegisterPdf
// signature), FR-18 (metadata/cover section), §13 Open Question 10 (SHA-256
// integrity stamp), and this session's implementation-order notes (the
// "grouped-by-Obligation layout": one section per Obligation, its
// ProcessTasks and HumanReview decisions listed underneath). Zero runtime
// dependencies — see README.md for why `@react-pdf/renderer` (the spec's
// own recommendation) could not be used in this environment, and
// xlsx-generator.ts's top-of-file comment for the equivalent XLSX story.
//
// A PDF file is: a `%PDF-1.4` header, a body of indirect objects
// (`N 0 obj ... endobj`), an xref table (a byte-offset index of every
// object), and a trailer pointing at the root Catalog object plus the
// xref table's own byte offset. This module writes exactly the objects a
// real reader needs:
//   1 0 obj  — Catalog (/Pages -> 2 0 R)
//   2 0 obj  — Pages (/Kids [...] /Count N)
//   3 0 obj  — Font (Type1 /BaseFont /Helvetica — one of the 14 standard
//              base fonts, so no font embedding/font file is needed at
//              all; every conformant PDF reader guarantees this font)
//   4..(3+N) 0 obj      — one Page object per page
//   (4+N)..(3+2N) 0 obj — one content-stream object per page (drawing
//              operators: BT/Tf/Tm/Tj/ET, see buildPageContentStream)
//
// Simplifications taken, documented rather than silently approximated:
//
// - **Text wrapping**: fixed-characters-per-line (CHARS_PER_LINE), not
//   real per-glyph AFM width metrics. Helvetica isn't monospace, so this
//   is an approximation (some wrapped lines will be visually shorter or
//   longer than others), but it is a legitimate, well-understood
//   simplification for a hand-rolled writer — see wrapText's own comment.
// - **Non-Latin-1 text**: a PDF content stream string literal without an
//   embedded font's CID/Unicode character map is limited to
//   WinAnsiEncoding/PDFDocEncoding, which is Latin-1-ish for code points
//   0x20-0xFF. This module strips/transliterates anything outside that
//   range to `?` (see escapePdfText) rather than attempting full Unicode
//   PDF text rendering (embedded fonts + CID mapping), which is a much
//   bigger undertaking out of scope here.
// - **Integrity hash**: computed via the SAME `computeIntegrityHash`
//   function xlsx-generator.ts uses (imported from ./integrity-hash.ts,
//   not re-derived here) — see that module's comment for why this must be
//   shared, not duplicated: the XLSX and PDF export of the same dataset
//   must produce an IDENTICAL hash.
import type { ComplianceRegisterRow } from "@sentinel-act/graph-db";
import { computeIntegrityHash } from "./integrity-hash.js";

// ---------------------------------------------------------------------------
// Public API — deliberately structurally IDENTICAL to XlsxMetadata
// (xlsx-generator.ts), not the `{generatedAt, asOfDate, filters,
// requestedBy, integrityHash}` shape floated in this task's own prompt.
// Reasons for the deviation:
//   - `generatedBy` (not `requestedBy`) matches XlsxMetadata's field name
//     exactly, so a caller (a future API route) can build ONE metadata
//     object and pass it to either generateXlsx or generatePdf
//     interchangeably — the whole point of "keep the two generators'
//     public APIs symmetric".
//   - No `integrityHash` field: like XlsxMetadata, the hash is computed
//     INSIDE this module from `rows` via the shared computeIntegrityHash
//     helper, not accepted as a caller-supplied input. Accepting it as a
//     parameter would let a caller pass a stale/mismatched hash; deriving
//     it here guarantees the embedded hash always matches the embedded
//     rows.
// ---------------------------------------------------------------------------
export interface PdfMetadata {
  asOfDate: string;
  generatedAt: string;
  generatedBy: string;
  filters: unknown;
}

// ---------------------------------------------------------------------------
// Page geometry — US Letter (612 x 792 points), 54pt (0.75in) margins on
// all sides. Chosen over A4 for no particular reason beyond "pick one and
// be consistent" (per this task's own instructions); nothing here depends
// on the choice.
// ---------------------------------------------------------------------------
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const TOP_Y = PAGE_HEIGHT - MARGIN; // 738 — first line's baseline y
const BOTTOM_Y = MARGIN; // 54 — once y would drop below this, start a new page
const BODY_FONT_SIZE = 10;
const TITLE_FONT_SIZE = 16;
const LEADING = 14; // baseline-to-baseline vertical spacing, points
const INDENT_WIDTH = 14; // points of x-offset per indent level

// Fixed-chars-per-line wrap budget. ~90 chars at 10pt Helvetica on a
// 504pt-wide text column (612 - 2*54 margins) is the ballpark this task's
// own instructions suggest; Helvetica's average glyph width at 10pt is
// roughly 5pt, so 504/5 ~= 100 — 90 leaves a safety margin for the
// (slightly wider than average) capital letters and digits common in
// obligation_id/circular_id/reviewer_id tokens.
const CHARS_PER_LINE = 90;

// Muted-gray fill color for section headings (Obligation heading lines,
// the cover page's "Filters applied:" label) — the one "visual read-only
// treatment" cue from ux/Sentinel_Act_Figma_Screen_Design_Spec.md §10
// ("muted/desaturated header treatment... visually distinct from the
// operator queue") that translates cleanly to a hand-rolled PDF: the `g`
// (nonstroking gray) operator works with the standard Helvetica font with
// no embedding required, unlike an actual color/weight change. 0.45 is a
// rough grayscale stand-in for that spec's `--muted-foreground` token
// (`#676F7E`, a mid-gray) — not a color-accurate conversion, just a
// legitimately "muted" value for a document that is otherwise pure black
// text on white.
const MUTED_GRAY = 0.45;

/** One line to be laid out on a page: text content (unescaped, unwrapped
 *  — wrapping happens before a LineRecord is created), an indent level
 *  (0 = left margin, each level adds INDENT_WIDTH points), and optional
 *  styling (gray = muted heading treatment, fontSize override for the
 *  cover page's title line). */
interface LineRecord {
  text: string;
  indent: number;
  gray?: boolean;
  fontSize?: number;
}

// ---------------------------------------------------------------------------
// Text wrapping — word-wrap at CHARS_PER_LINE, with a hard split for any
// single "word" longer than the budget (a pathological but possible input,
// e.g. a URL or an unbroken identifier) so no line is ever silently
// dropped or left overflowing the page width in a way that would look
// broken rather than merely approximate.
// ---------------------------------------------------------------------------
function hardSplit(word: string, maxChars: number): string[] {
  if (word.length <= maxChars) {
    return [word];
  }
  const chunks: string[] = [];
  for (let i = 0; i < word.length; i += maxChars) {
    chunks.push(word.slice(i, i + maxChars));
  }
  return chunks;
}

export function wrapText(text: string, maxChars: number = CHARS_PER_LINE): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return [""];
  }
  const words = normalized.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length > maxChars && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines.flatMap((line) => hardSplit(line, maxChars));
}

// ---------------------------------------------------------------------------
// PDF string-literal escaping. Inside a `(...)` literal, a literal
// backslash, `(`, or `)` MUST be backslash-escaped, or the reader's
// paren-balancing parse of the string breaks (per the PDF spec, §7.3.4.2).
// Separately: this module's simplified stance on non-Latin-1 text (see
// top-of-file comment) — anything outside printable ASCII/Latin-1
// (0x20-0xFF, excluding control characters) is replaced with `?` rather
// than attempting real Unicode/CID text rendering. Newlines/control
// characters inside a value are replaced with a single space (an embedded
// literal newline would prematurely end the visual line without the
// layout code's knowledge, since layout only tracks LEADING per
// LineRecord, not per embedded newline).
// ---------------------------------------------------------------------------
export function escapePdfText(raw: string): string {
  let out = "";
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    let mapped: string;
    if (code === 0x0a || code === 0x0d || code < 0x20) {
      mapped = " ";
    } else if (code > 0xff) {
      mapped = "?";
    } else {
      mapped = char;
    }
    if (mapped === "\\" || mapped === "(" || mapped === ")") {
      out += `\\${mapped}`;
    } else {
      out += mapped;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cover / FR-18 metadata page. Rendered as readable text (not raw JSON)
// for `filters`, per this task's instructions — `describeFilters` turns a
// `{ obligationCategory?, tier?, ... }`-shaped object into "Label: value"
// lines rather than a JSON blob.
// ---------------------------------------------------------------------------
function humanizeFilterKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function describeFilters(filters: unknown): string[] {
  if (filters === null || filters === undefined) {
    return ["None (no filters applied)"];
  }
  if (typeof filters !== "object") {
    return [String(filters)];
  }
  const entries = Object.entries(filters as Record<string, unknown>).filter(
    ([, value]) => value !== null && value !== undefined && value !== ""
  );
  if (entries.length === 0) {
    return ["None (no filters applied)"];
  }
  return entries.map(([key, value]) => `${humanizeFilterKey(key)}: ${String(value)}`);
}

function buildCoverLines(rows: ComplianceRegisterRow[], metadata: PdfMetadata): LineRecord[] {
  const integrityHash = computeIntegrityHash(rows);
  const lines: LineRecord[] = [];

  lines.push({ text: "Compliance Register Export", indent: 0, fontSize: TITLE_FONT_SIZE });
  lines.push({ text: "", indent: 0 });
  lines.push({ text: `As-of date: ${metadata.asOfDate}`, indent: 0 });
  lines.push({ text: `Generated at: ${metadata.generatedAt}`, indent: 0 });
  lines.push({ text: `Requested by: ${metadata.generatedBy}`, indent: 0 });
  lines.push({ text: `Row count: ${rows.length}`, indent: 0 });
  lines.push({ text: "", indent: 0 });
  lines.push({ text: "Filters applied:", indent: 0, gray: true });
  for (const filterLine of describeFilters(metadata.filters)) {
    lines.push({ text: filterLine, indent: 1 });
  }
  lines.push({ text: "", indent: 0 });
  lines.push({ text: "Integrity hash (SHA-256 of dataset):", indent: 0, gray: true });
  lines.push({ text: integrityHash, indent: 1 });
  lines.push({
    text: "This hash is computed identically for the XLSX export of the same dataset - the two files can be cross-checked.",
    indent: 1
  });

  return lines;
}

// ---------------------------------------------------------------------------
// Grouped-by-Obligation content. `ComplianceRegisterRow[]` is the flat,
// already-cross-joined shape `toRegisterRows` produces (see that module's
// own comment: an Obligation with >1 ProcessTask and/or >1 HumanReview can
// appear across several rows, all sharing one `obligation_id`). Grouping
// must DE-DUPLICATE tasks/reviews within a group (keyed by task_id /
// review_id) rather than re-listing the same task or review once per row
// it appears in — otherwise a 2-task x 2-review obligation (4
// ComplianceRegisterRows, see to-register-rows.ts's documented cross-
// product oddity) would print each task twice and each review twice.
// ---------------------------------------------------------------------------
interface TaskLike {
  task_id: string;
  task_name: string | null;
  owner_role: string | null;
  sla_hours: number | null;
  system_touchpoint: string | null;
  risk_score: number | null;
}

interface ReviewLike {
  review_id: string;
  reviewer_id: string | null;
  review_tier: string | null;
  decision: string | null;
  rationale: string | null;
  decided_at: string | null;
}

interface ObligationGroup {
  obligation_id: string;
  obligation_category: string;
  requirement_text: string;
  deadline_rule: string;
  responsible_role: string;
  obligation_status: string;
  confidence_score: number;
  grounding_score: number;
  tasks: Map<string, TaskLike>;
  reviews: Map<string, ReviewLike>;
  /** Set if ANY row in this group is a genuine FR-14 synthetic Tier A row
   *  (decision === "auto-committed"). Used only when `reviews` ends up
   *  empty, to distinguish "Tier A, nothing to review" from "not yet
   *  reviewed" (see to-register-rows.ts's second documented judgment
   *  call). */
  hasTierACommitted: boolean;
}

function groupByObligation(rows: ComplianceRegisterRow[]): ObligationGroup[] {
  const groups = new Map<string, ObligationGroup>();

  for (const row of rows) {
    let group = groups.get(row.obligation_id);
    if (!group) {
      group = {
        obligation_id: row.obligation_id,
        obligation_category: row.obligation_category,
        requirement_text: row.requirement_text,
        deadline_rule: row.deadline_rule,
        responsible_role: row.responsible_role,
        obligation_status: row.obligation_status,
        confidence_score: row.confidence_score,
        grounding_score: row.grounding_score,
        tasks: new Map(),
        reviews: new Map(),
        hasTierACommitted: false
      };
      groups.set(row.obligation_id, group);
    }

    if (row.task_id !== null) {
      group.tasks.set(row.task_id, {
        task_id: row.task_id,
        task_name: row.task_name,
        owner_role: row.owner_role,
        sla_hours: row.sla_hours,
        system_touchpoint: row.system_touchpoint,
        risk_score: row.risk_score
      });
    }

    if (row.review_id !== null) {
      group.reviews.set(row.review_id, {
        review_id: row.review_id,
        reviewer_id: row.reviewer_id,
        review_tier: row.review_tier,
        decision: row.decision,
        rationale: row.rationale,
        decided_at: row.decided_at
      });
    } else if (row.decision === "auto-committed") {
      group.hasTierACommitted = true;
    }
  }

  return [...groups.values()];
}

function buildContentLines(rows: ComplianceRegisterRow[]): LineRecord[] {
  const groups = groupByObligation(rows);
  if (groups.length === 0) {
    return [{ text: "No Obligation records match the requested asOfDate/filters.", indent: 0 }];
  }

  const lines: LineRecord[] = [];

  for (const group of groups) {
    lines.push({ text: `Obligation ${group.obligation_id} - ${group.obligation_category}`, indent: 0, gray: true });
    for (const wrapped of wrapText(group.requirement_text)) {
      lines.push({ text: wrapped, indent: 1 });
    }
    lines.push({
      text: `Deadline: ${group.deadline_rule}  |  Responsible: ${group.responsible_role}  |  Status: ${group.obligation_status}`,
      indent: 1
    });
    lines.push({
      text: `Confidence: ${group.confidence_score}  Grounding: ${group.grounding_score}`,
      indent: 1
    });

    lines.push({ text: "Process Tasks:", indent: 1, gray: true });
    if (group.tasks.size === 0) {
      lines.push({ text: "(no ProcessTask mapped)", indent: 2 });
    } else {
      for (const task of group.tasks.values()) {
        const summary =
          `- ${task.task_id} ${task.task_name ?? "(unnamed task)"} ` +
          `(owner: ${task.owner_role ?? "n/a"}, SLA: ${task.sla_hours ?? "n/a"}h, ` +
          `touchpoint: ${task.system_touchpoint ?? "n/a"}, risk: ${task.risk_score ?? "n/a"})`;
        for (const wrapped of wrapText(summary)) {
          lines.push({ text: wrapped, indent: 2 });
        }
      }
    }

    lines.push({ text: "Human Review Decisions:", indent: 1, gray: true });
    if (group.reviews.size === 0) {
      if (group.hasTierACommitted) {
        lines.push({ text: "Auto-committed (Tier A) - no human review required.", indent: 2 });
      } else {
        lines.push({ text: "No human review recorded yet.", indent: 2 });
      }
    } else {
      for (const review of group.reviews.values()) {
        const summary = `- ${review.reviewer_id ?? "n/a"} - ${review.decision ?? "n/a"} (tier ${review.review_tier ?? "n/a"}, decided ${review.decided_at ?? "n/a"})`;
        for (const wrapped of wrapText(summary)) {
          lines.push({ text: wrapped, indent: 2 });
        }
        if (review.rationale) {
          for (const wrapped of wrapText(`Rationale: ${review.rationale}`)) {
            lines.push({ text: wrapped, indent: 3 });
          }
        }
      }
    }

    lines.push({ text: "", indent: 0 });
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Pagination: chunk a flat LineRecord[] into pages of at most
// `linesPerPage` records each. The cover section and the content section
// are chunked SEPARATELY and never share a page (`generatePdf` below
// concatenates the two page-arrays rather than one continuous line
// stream), so the cover/metadata page is always its own dedicated page
// per FR-18, even when it is short enough to physically fit alongside the
// first Obligation section.
// ---------------------------------------------------------------------------
function chunkLines(lines: LineRecord[], linesPerPage: number): LineRecord[][] {
  if (lines.length === 0) {
    return [[]];
  }
  const pages: LineRecord[][] = [];
  for (let i = 0; i < lines.length; i += linesPerPage) {
    pages.push(lines.slice(i, i + linesPerPage));
  }
  return pages;
}

// ---------------------------------------------------------------------------
// Content-stream rendering: BT ... (Tf / g / Tm / Tj per line) ... ET.
// Positioning uses an absolute `Tm` (text matrix) per line rather than
// relative `Td` deltas — indentation varies per line (0/1/2/3 levels), so
// tracking a running x/y delta would need the same absolute-position
// bookkeeping anyway; emitting it directly is simpler and just as valid.
// PDF's coordinate origin is bottom-left with y increasing upward, so the
// layout starts at TOP_Y and decrements by LEADING per line.
// ---------------------------------------------------------------------------
function buildPageContentStream(lines: LineRecord[]): string {
  const ops: string[] = ["BT"];
  let y = TOP_Y;
  let currentFontSize = -1;
  let currentGray = -1;

  for (const line of lines) {
    const fontSize = line.fontSize ?? BODY_FONT_SIZE;
    if (fontSize !== currentFontSize) {
      ops.push(`/F1 ${fontSize} Tf`);
      currentFontSize = fontSize;
    }
    const gray = line.gray ? MUTED_GRAY : 0;
    if (gray !== currentGray) {
      ops.push(`${gray} g`);
      currentGray = gray;
    }
    const x = MARGIN + line.indent * INDENT_WIDTH;
    ops.push(`1 0 0 1 ${x} ${y} Tm`);
    ops.push(`(${escapePdfText(line.text)}) Tj`);
    y -= LEADING;
  }

  ops.push("ET");
  return ops.join("\n");
}

// ---------------------------------------------------------------------------
// Low-level PDF object assembly: header, indirect objects (Catalog, Pages,
// Font, one Page + one content stream per page), xref table, trailer.
// Object numbering scheme:
//   1              Catalog
//   2              Pages
//   3              Font (Helvetica)
//   4..(3+N)       Page objects, one per page
//   (4+N)..(3+2N)  Content stream objects, one per page (paired by index
//                  with the Page object N earlier: page i's content is
//                  object (4+N+i))
//
// Every character emitted into `doc` (structural PDF syntax, plus every
// piece of page text — already passed through escapePdfText, which maps
// anything outside 0x20-0xFF to `?`) is guaranteed to be a single Latin-1
// code point, so `doc.length` (UTF-16 code units) and the document's true
// byte length coincide when written out with the "latin1" encoding. This
// is what makes computing exact xref byte offsets by simple string
// concatenation correct, without a separate byte-counting pass.
// ---------------------------------------------------------------------------
function assemblePdf(pages: LineRecord[][]): Buffer {
  const numPages = pages.length;
  const catalogObjNum = 1;
  const pagesObjNum = 2;
  const fontObjNum = 3;
  const firstPageObjNum = 4;
  const firstContentObjNum = firstPageObjNum + numPages;
  const totalObjects = firstContentObjNum + numPages - 1;

  const objectBodies: string[] = new Array(totalObjects + 1).fill("");

  objectBodies[catalogObjNum] = `<< /Type /Catalog /Pages ${pagesObjNum} 0 R >>`;

  const kids = Array.from({ length: numPages }, (_, i) => `${firstPageObjNum + i} 0 R`).join(" ");
  objectBodies[pagesObjNum] = `<< /Type /Pages /Kids [${kids}] /Count ${numPages} >>`;

  objectBodies[fontObjNum] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;

  for (let i = 0; i < numPages; i++) {
    const pageObjNum = firstPageObjNum + i;
    const contentObjNum = firstContentObjNum + i;

    objectBodies[pageObjNum] =
      `<< /Type /Page /Parent ${pagesObjNum} 0 R ` +
      `/Resources << /Font << /F1 ${fontObjNum} 0 R >> >> ` +
      `/MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Contents ${contentObjNum} 0 R >>`;

    const streamContent = buildPageContentStream(pages[i]);
    objectBodies[contentObjNum] = `<< /Length ${streamContent.length} >>\nstream\n${streamContent}\nendstream`;
  }

  let doc = "%PDF-1.4\n";
  const offsets: number[] = new Array(totalObjects + 1).fill(0);
  for (let num = 1; num <= totalObjects; num++) {
    offsets[num] = doc.length;
    doc += `${num} 0 obj\n${objectBodies[num]}\nendobj\n`;
  }

  const xrefOffset = doc.length;
  doc += `xref\n0 ${totalObjects + 1}\n`;
  doc += "0000000000 65535 f \n";
  for (let num = 1; num <= totalObjects; num++) {
    doc += `${String(offsets[num]).padStart(10, "0")} 00000 n \n`;
  }
  doc += `trailer\n<< /Size ${totalObjects + 1} /Root ${catalogObjNum} 0 R >>\n`;
  doc += `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(doc, "latin1");
}

/** Generates a complete, valid PDF file (as a Buffer) for the Compliance
 *  Register Export: a cover/FR-18 metadata page first (asOfDate,
 *  generatedAt, generatedBy, filters as readable text, rowCount, and the
 *  same SHA-256 integrity hash the XLSX export embeds), followed by one
 *  section per Obligation (grouped-by-Obligation layout), each listing
 *  its ProcessTasks and HumanReview decisions (or "Auto-committed (Tier
 *  A)" for the synthetic Tier-A rows `to-register-rows.ts` produces).
 *  Pure function — no I/O, no Next.js, no Neo4j driver, matching Spec 10
 *  §5.6's constraint (see xlsx-generator.ts's doc comment on the same
 *  `Promise<Buffer>` vs `Buffer` point). */
export function generatePdf(rows: ComplianceRegisterRow[], metadata: PdfMetadata): Buffer {
  const linesPerPage = Math.floor((TOP_Y - BOTTOM_Y) / LEADING);

  const coverPages = chunkLines(buildCoverLines(rows, metadata), linesPerPage);
  const contentPages = chunkLines(buildContentLines(rows), linesPerPage);

  return assemblePdf([...coverPages, ...contentPages]);
}
