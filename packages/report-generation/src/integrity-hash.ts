// Shared SHA-256 integrity-hash computation for the Compliance Register
// Export (Spec 10 FR-18, §13 Open Question 10: "embed a SHA-256 hash of
// the serialized ComplianceRegisterRow[] dataset itself in the FR-18
// metadata section").
//
// Extracted out of xlsx-generator.ts (where this logic originally lived)
// into its own module specifically so pdf-generator.ts can call the EXACT
// SAME function rather than re-deriving equivalent-looking hash logic a
// second time. The whole point of Open Question 10's recommendation only
// holds if the XLSX export and the PDF export of the SAME dataset produce
// an IDENTICAL digest — a recipient who has both files should be able to
// treat the two hashes as a single cross-format integrity check. Two
// independently hand-written serializations (even if "equivalent" in
// intent) risk silently drifting — a reordered column, a different
// null-handling convention, a different separator choice — and any such
// drift would defeat the hash's purpose. Both generators import
// `computeIntegrityHash` from here; neither defines its own copy.
import { createHash } from "node:crypto";
import type { ComplianceRegisterRow } from "@sentinel-act/graph-db";

// ---------------------------------------------------------------------------
// §4.2's exact column set, in the interface's own declaration order. This
// list serves two purposes that must stay in lockstep:
//   1. xlsx-generator.ts's sheet1 header row / cell order (traceability
//      back to the §4.2 contract — see that file's own comment).
//   2. This module's canonical hash input order — a recipient re-deriving
//      the hash from sheet1's data (top to bottom, in this column order)
//      reproduces the identical digest. Moving it here (rather than
//      leaving a second copy in xlsx-generator.ts) is itself part of the
//      "don't let the two hash computations drift" guarantee: there is
//      now only one column-order list in the whole package.
// ---------------------------------------------------------------------------
export const REGISTER_COLUMNS: ReadonlyArray<keyof ComplianceRegisterRow> = [
  "circular_id",
  "circular_title",
  "circular_date_issued",
  "circular_date_effective",
  "clause_para_ref",
  "obligation_id",
  "obligation_category",
  "requirement_text",
  "deadline_rule",
  "responsible_role",
  "penalty_ref",
  "obligation_status",
  "confidence_score",
  "grounding_score",
  "task_id",
  "task_name",
  "owner_role",
  "sla_hours",
  "system_touchpoint",
  "risk_score",
  "review_id",
  "reviewer_id",
  "review_tier",
  "decision",
  "rationale",
  "decided_at"
];

/** Canonical, deterministic serialization of the register rows used as
 *  the integrity hash's input. Deliberately NOT `JSON.stringify(rows)`:
 *  this joins each row's §4.2 column values (in the exact REGISTER_COLUMNS
 *  order) with unit/row separator control characters that cannot appear
 *  in any real field value, so the hash is stable and independent of
 *  incidental JS object key ordering. A recipient re-deriving this hash
 *  from either export format's data (in column order, top to bottom) can
 *  reproduce the same string and therefore the same hash. */
export function serializeRowsForHash(rows: ComplianceRegisterRow[]): string {
  const UNIT_SEPARATOR = "\x1f"; // ASCII Unit Separator (0x1F)
  const ROW_SEPARATOR = "\x1e"; // ASCII Record Separator (0x1E)
  return rows
    .map((row) => REGISTER_COLUMNS.map((key) => (row[key] === null || row[key] === undefined ? "" : String(row[key]))).join(UNIT_SEPARATOR))
    .join(ROW_SEPARATOR);
}

export function computeIntegrityHash(rows: ComplianceRegisterRow[]): string {
  return createHash("sha256").update(serializeRowsForHash(rows), "utf8").digest("hex");
}
