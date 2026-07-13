// Spec 10 §4.1/§4.2 — Observer Mode / Compliance Register data contracts.
// Domain node/edge shapes are imported unchanged from @sentinel-act/graph-schema
// (Spec 00 constraint: never rename/add a field on those interfaces here).
//
// This file covers both §4.1 (audit query filters/results) and §4.2
// (Compliance Register export contracts) per the spec's own package
// layout (§5.1): a single audit-query.types.ts backs both audit-query.ts
// (this task) and export-job-store.ts / packages/report-generation
// (later tasks in the Spec 10 breakdown) so those modules import from one
// place rather than redeclaring the same shapes.
import type { Circular, Clause, Obligation, ProcessTask, HumanReview, ReviewTier, ReviewDecision } from "@sentinel-act/graph-schema";

// ---------------------------------------------------------------------------
// §4.1 — Audit query filters and results.
// ---------------------------------------------------------------------------

/** Query params for GET /api/audit/reviews. All fields optional — an
 *  empty filter set returns every HumanReview fact, newest first. */
export interface AuditQueryFilters {
  obligationId?: string; // exact match on Obligation.obligation_id
  circularId?: string; // exact match on Circular.circular_id
  reviewerId?: string; // case-insensitive substring match on HumanReview.reviewer_id
  freeText?: string; // case-insensitive substring match across
  // Obligation.requirement_text, Circular.title, Clause.para_ref (see FR-4)
  tier?: ReviewTier; // "A" | "B" | "C" — note Tier A never has a
  // HumanReview row (see FR-6); filtering tier=A always returns zero rows, by design
  decision?: ReviewDecision; // "approve" | "reject"
  decidedFrom?: string; // ISO date, inclusive lower bound on decided_at
  decidedTo?: string; // ISO date, inclusive upper bound on decided_at
  page?: number; // default 1
  pageSize?: number; // default 50, max 200 (see NFR-1)
}

/** One row of the audit results table: a single HumanReview fact plus its
 *  full lineage back to source. */
export interface AuditTrailRow {
  review: HumanReview;
  obligation: Pick<
    Obligation,
    "obligation_id" | "category" | "requirement_text" | "status" | "confidence_score" | "grounding_score" | "penalty_ref"
  >;
  clause: Pick<Clause, "clause_id" | "para_ref"> | null;
  circular: Pick<Circular, "circular_id" | "title" | "date_issued" | "date_effective"> | null;
  processTasks: Pick<ProcessTask, "task_id" | "task_name" | "risk_score">[];
}

export interface AuditQueryResponse {
  rows: AuditTrailRow[];
  totalCount: number; // total matching rows before pagination
  page: number;
  pageSize: number;
}

/** Raw per-Obligation shape returned by AuditQueryService.findRegisterAsOf
 *  (§4.4, §5.2) — one row per Obligation valid as of the requested date,
 *  with every ProcessTask/HumanReview it maps to collected onto it. Not
 *  named in §4.1/§4.2 directly (the spec's §5.2 signature just says
 *  `Promise<RegisterQueryRow[]>`) — this is the narrowest shape that
 *  carries everything packages/report-generation's to-register-rows.ts
 *  needs to flatten into ComplianceRegisterRow[] (FR-14/FR-15), including
 *  full Obligation/ProcessTask fields the audit-trail row's Pick<> subset
 *  above deliberately omits (deadline_rule, responsible_role, owner_role,
 *  sla_hours, system_touchpoint). */
export interface RegisterQueryRow {
  obligation: Obligation;
  clause: Pick<Clause, "clause_id" | "para_ref"> | null;
  circular: Pick<Circular, "circular_id" | "title" | "date_issued" | "date_effective"> | null;
  tasks: Pick<ProcessTask, "task_id" | "task_name" | "owner_role" | "sla_hours" | "system_touchpoint" | "risk_score">[];
  reviews: HumanReview[];
}

// ---------------------------------------------------------------------------
// §4.2 — Compliance Register Export contracts.
// ---------------------------------------------------------------------------

export type ExportFormat = "pdf" | "xlsx";
export type ExportJobStatus = "queued" | "running" | "completed" | "failed";

/** Body of POST /api/audit/export. */
export interface ComplianceRegisterExportRequest {
  asOfDate: string; // ISO date, required — see FR-11
  format: ExportFormat;
  filters?: {
    obligationCategory?: string;
    intermediaryCategoryName?: string;
    tier?: ReviewTier;
  };
  requestedBy: string; // reviewer_id / auditor identity from the session (see §7.4)
}

/** Persisted as a non-canonical `:ExportJob` node in the same Neo4j
 *  instance — same precedent as Spec 01's `:SchemaMigration`/`:CommitLog`
 *  infra-only labels (§6, §13). Not part of the Regulatory Knowledge
 *  Graph schema v1.1; never referenced by any Obligation/Circular query. */
export interface ComplianceRegisterExportJob {
  exportId: string; // uuid v4
  status: ExportJobStatus;
  requestedAt: string; // ISO datetime, DB-clock-derived
  requestedBy: string;
  asOfDate: string;
  format: ExportFormat;
  filters: ComplianceRegisterExportRequest["filters"];
  rowCount: number | null; // set once generation completes
  filePath: string | null; // server-local path or object-store key (§13)
  fileSizeBytes: number | null;
  errorMessage: string | null; // set only if status === "failed"
  completedAt: string | null;
  expiresAt: string; // requestedAt + 7 days default (§13, FR-16)
}

/** One flattened row of the register — the unit of both the XLSX sheet
 *  and the PDF's per-obligation review listing. One row per HumanReview,
 *  OR one synthetic row per Tier-A Obligation with review fields null
 *  (see FR-14). */
export interface ComplianceRegisterRow {
  // Circular
  circular_id: string | null;
  circular_title: string | null;
  circular_date_issued: string | null;
  circular_date_effective: string | null;
  // Clause
  clause_para_ref: string | null;
  // Obligation
  obligation_id: string;
  obligation_category: string;
  requirement_text: string;
  deadline_rule: string;
  responsible_role: string;
  penalty_ref: string | null;
  obligation_status: Obligation["status"];
  confidence_score: number;
  grounding_score: number;
  // ProcessTask (repeated per task if an obligation maps to more than one — see FR-15)
  task_id: string | null;
  task_name: string | null;
  owner_role: string | null;
  sla_hours: number | null;
  system_touchpoint: string | null;
  risk_score: number | null;
  // HumanReview (null for Tier A rows)
  review_id: string | null;
  reviewer_id: string | null;
  review_tier: ReviewTier | "A" | null;
  decision: ReviewDecision | "auto-committed" | null;
  rationale: string | null;
  decided_at: string | null;
}
