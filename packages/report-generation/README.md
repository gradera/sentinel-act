# @sentinel-act/report-generation

Spec 10 §5.6 report generators for the Compliance Register Export
(`ComplianceRegisterRow[]` → downloadable file). Pure functions: rows/meta
in, `Buffer` out — no Next.js, no Neo4j driver, no filesystem access inside
this package (Spec 10 §5.6).

## Why this package has zero runtime dependencies

Spec 10 §3/§13 (Open Questions 3 & 4) recommend `exceljs` for XLSX
generation and `@react-pdf/renderer` for PDF generation. **Neither is used
here.** This is not a design preference — it is a hard environment
constraint for this build:

- The mounted filesystem this repo lives on unconditionally blocks file
  deletion/unlink for the operating user (confirmed: even a file created
  moments earlier by this same process cannot be removed).
- `pnpm install` (and `corepack`-invoked variants of it) needs to unlink
  temporary files as part of its own internal bookkeeping partway through
  a dependency install. That unlink always fails here, so `pnpm install`
  can never complete successfully in this environment, for any package,
  ever — it is not specific to `exceljs`/`@react-pdf/renderer` themselves.
- Consequently, **no new npm dependency of any kind can be added** to this
  monorepo from this environment. `exceljs` and `@react-pdf/renderer` are
  therefore both off the table, full stop.

### What was substituted

- **XLSX** (`src/xlsx-generator.ts`): a hand-rolled OOXML `.xlsx` writer
  using only Node's built-in `node:zlib` (`deflateRawSync`) and a from-
  scratch table-based CRC-32 implementation (`src/crc32.ts`, standard IEEE
  802.3 / ZIP polynomial `0xEDB88320`). It produces a genuinely valid ZIP
  container (local file headers + central directory + end-of-central-
  directory record) wrapping the minimal set of OOXML spreadsheet parts
  needed for a real, two-sheet workbook. See that file's top-of-file
  comment for the exact structure and the simplifications taken
  (inline strings instead of a shared-strings table — legitimate, not a
  correctness compromise).
- **PDF** (`src/pdf-generator.ts`): a hand-rolled PDF 1.4 writer using only
  string/Buffer manipulation — no rendering library, no headless browser.
  Uses the Helvetica standard base-14 font (no embedding/font file
  needed), a fixed-chars-per-line word wrap (not real AFM glyph-width
  metrics), and strips/transliterates non-Latin-1 text to `?` (documented
  in that file's top-of-file comment). Produces a cover/FR-18 metadata
  page followed by one section per Obligation (grouped-by-Obligation
  layout), paginating once content overflows a page's line budget.

## `integrity-hash.ts`

`computeIntegrityHash`/`serializeRowsForHash`/`REGISTER_COLUMNS` — shared
between `xlsx-generator.ts` and `pdf-generator.ts` so both export formats
of the same dataset produce an IDENTICAL SHA-256 integrity stamp (§13 Open
Question 10). See that file's top-of-file comment for why this was pulled
out into its own module rather than left duplicated.

## `to-register-rows.ts`

Flattens `RegisterQueryRow[]` (graph-db's nested per-Obligation shape, one
node per Obligation with its tasks/reviews collected onto it) into
`ComplianceRegisterRow[]` (the flat one-row-per-fact shape both the XLSX
sheet and any future PDF listing consume). See that file's top-of-file
comment for the exact FR-14/FR-15 cross-product rule implemented and why.
