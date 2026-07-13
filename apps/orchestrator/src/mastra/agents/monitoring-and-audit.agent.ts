// Monitoring and Audit Agent — deterministic (Spec 07). NOT an LLM call.
// Tracks ProcessTask fulfilment against sla_hours, ingests EvidenceArtifact
// uploads (server-computed hash only, never a client-declared one), and is
// the *only* agent in the system permitted to write HumanReview nodes —
// the documented, narrow exception to "fanned-out agents only ever
// propose" (§1). Also owns appendLedgerEntry/queryLedger, the sole
// read/write surface for the Hash-chained Audit Ledger
// (@sentinel-act/audit-ledger).
//
// FR-1: this file, and every file it imports, MUST NEVER import an
// LLM/model client. If a future change to this unit ever needs one, that
// is a bug, not a design choice.
import { createHash, randomUUID } from "node:crypto";
import type { EvidenceArtifact, HumanReview, ProcessTask, ReviewDecision, ReviewTier } from "@sentinel-act/graph-schema";
import type { CommitPlan, CommitResult } from "@sentinel-act/graph-db";
import type {
  AuditLedgerPort,
  ChainVerificationResult,
  LedgerAppendInput,
  LedgerEntry,
  LedgerQuery
} from "@sentinel-act/audit-ledger";
import {
  MonitoringAuditInvariantError,
  ReviewAlreadyCompleteError,
  SameReviewerNotAllowedError,
  ValidationError
} from "./monitoring-and-audit.errors.js";

// ---------------------------------------------------------------------------
// §4 (first code block) — new types local to this unit
// ---------------------------------------------------------------------------

export interface GraphQueryPort {
  runCypher<T = Record<string, unknown>>(query: string, params: Record<string, unknown>): Promise<T[]>;
}

/** Narrowed on purpose: this is the *only* graph-write capability this
 *  unit is granted (§1's documented exception). Satisfied by
 *  `@sentinel-act/graph-db`'s `GraphWriter` class directly — same method
 *  signature, no adapter needed. */
export interface GraphWriterPort {
  commitProposal(plan: CommitPlan): Promise<CommitResult>;
}

export interface MonitoringAuditContext {
  graph: GraphQueryPort;
  graphWriter: GraphWriterPort;
  ledger: AuditLedgerPort;
  /** ISO datetime used as "now" for every deadline/threshold computation
   *  in this unit. Always passed explicitly — never read from the wall
   *  clock inside a pure helper — for the same determinism/replay reason
   *  as Spec 05's `referenceDate` (NFR-6 there, NFR-8 here). */
  referenceDate: string;
  graphTimeoutMs?: number; // default 2000, same convention as Spec 05
}

// ---- SLA / ProcessTask fulfilment monitoring ----

export type SlaStatus = "on_track" | "approaching" | "breached_unfulfilled" | "fulfilled_on_time" | "fulfilled_late";

export interface SlaGapReport {
  task_id: string;
  obligation_id: string;
  owner_role: string;
  deadline: string; // ISO datetime, computeTaskDeadline() output
  status: SlaStatus;
  hoursElapsedRatio: number; // 0..1+, elapsed / sla_hours, uncapped above 1
  hasEvidence: boolean;
  latestEvidenceUploadedAt: string | null;
}

// ---- Evidence ingestion ----

export interface EvidenceArtifactUploadInput {
  task_id: string;
  type: string;
  uploaded_by: string;
  /** Raw file bytes. This unit always computes SHA-256 over these bytes
   *  itself; it never trusts a caller-declared hash as the persisted
   *  value (see FR-14). */
  file: Buffer;
  /** Optional integrity-check value the client computed before upload. If
   *  present and it does NOT match the server-computed hash, the upload
   *  is rejected — see FR-15. If absent, only the server-computed hash
   *  is used, no comparison happens. */
  claimedHash?: string;
  /** Optional; defaults to `ctx.referenceDate` if absent. */
  uploadedAt?: string;
}

export type EvidenceIngestOutcome = "ingested" | "duplicate" | "hash_mismatch";

export interface EvidenceIngestResult {
  outcome: EvidenceIngestOutcome;
  evidenceArtifact: EvidenceArtifact | null; // null only when outcome === "hash_mismatch"
  computedHash: string;
  ledgerEntry: LedgerEntry; // always written, even on hash_mismatch — see FR-16
}

// ---- HumanReview recording ----

export interface HumanReviewSubmittedEvent {
  event_id: string; // uuid v4, caller-generated, idempotency key (FR-24)
  obligation_id: string;
  reviewer_id: string;
  tier: ReviewTier; // "B" | "C" only — "A" is rejected, see FR-19
  decision: ReviewDecision; // "approve" | "reject"
  rationale: string | null; // required non-empty when tier === "C", see FR-22
  decided_at: string; // ISO datetime, client-submitted
  source: "web-console" | "slack";
  /** Traceability handle into the source system: console session/request
   *  id, or Slack {channel, message_ts, user_id} serialized. Opaque to
   *  this unit, stored verbatim in the ledger payload. */
  source_ref: string | null;
}

export type ReviewOutcome =
  | "AWAITING_SECOND_REVIEWER" // Tier C, first of two reviews recorded
  | "APPROVED" // Tier B single approve, or Tier C both approve
  | "REJECTED" // Tier B single reject, or Tier C both reject
  | "ESCALATED_DISAGREEMENT"; // Tier C, reviewers disagree (Journey B)

export interface RecordHumanReviewResult {
  humanReview: HumanReview;
  reviewOutcome: ReviewOutcome;
  /** All HumanReview nodes now on this obligation, in submission order —
   *  handed to Spec 08 so it has everything needed to decide the
   *  Obligation.status transition without a second graph round trip. */
  allReviewsForObligation: HumanReview[];
  ledgerEntry: LedgerEntry;
}

// ---------------------------------------------------------------------------
// Constants (placeholders pending compliance/ops sign-off — §13)
// ---------------------------------------------------------------------------

/** FR-5, §13: unconfirmed placeholder pending compliance sign-off. */
export const SLA_APPROACHING_THRESHOLD_RATIO = 0.8;

/** NFR-6, §13: arbitrary placeholder pending an evidence-type survey. */
export const MAX_EVIDENCE_FILE_SIZE_BYTES = 25 * 1024 * 1024;

/** Same convention as Spec 05's DEFAULT_GRAPH_TIMEOUT_MS. */
export const DEFAULT_GRAPH_TIMEOUT_MS = 2000;

// ---------------------------------------------------------------------------
// Cypher query shapes (§4)
// ---------------------------------------------------------------------------

const SLA_GAP_SCAN_CYPHER = `
  MATCH (t:ProcessTask)
  WHERE t.valid_to IS NULL
  OPTIONAL MATCH (t)-[:EVIDENCED_BY]->(e:EvidenceArtifact)
  RETURN t, collect(e) AS evidenceArtifacts
`;

// Spec §4's illustrative Cypher has a trailing `ORDER BY r.decided_at
// ASC` placed *after* `RETURN ... collect(r) ...`, which does not
// compile against real Neo4j (r is aggregated away by collect() before
// an ORDER BY on a bare r.property could apply). Corrected here by
// sorting before the aggregation (`WITH o, r ORDER BY r.decided_at ASC`)
// so the resulting `existingReviews` list is submission-ordered, which
// FR-26's Tier C first/second logic depends on.
const OBLIGATION_REVIEWS_CYPHER = `
  MATCH (o:Obligation {obligation_id: $obligationId})
  OPTIONAL MATCH (o)-[:REVIEWED_BY]->(r:HumanReview)
  WITH o, r
  ORDER BY r.decided_at ASC
  RETURN o.status AS obligationStatus, collect(r) AS existingReviews
`;

const DUPLICATE_EVIDENCE_HASH_CYPHER = `
  MATCH (t:ProcessTask {task_id: $taskId})-[:EVIDENCED_BY]->(e:EvidenceArtifact {hash: $computedHash})
  RETURN e
  LIMIT 1
`;

const TASK_EXISTS_CYPHER = `
  MATCH (t:ProcessTask {task_id: $taskId})
  RETURN t
  LIMIT 1
`;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

class GraphQueryTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphQueryTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new GraphQueryTimeoutError(`Graph query exceeded ${timeoutMs}ms budget`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** Real Neo4j driver rows return whole nodes as `{ properties, labels,
 *  ... }`-shaped objects (see mapping-risk-scoring.graph.ts's
 *  Neo4jRecordLike doc comment); a hand-rolled fake GraphQueryPort in
 *  unit tests instead returns plain property maps directly. Defensively
 *  unwrap either shape so this unit's Cypher-consuming functions work
 *  against both without a hard dependency on the neo4j-driver package. */
function unwrapNodeProperties<T>(value: unknown): T | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "object" && "properties" in (value as Record<string, unknown>)) {
    return (value as { properties: T }).properties;
  }
  return value as T;
}

function toIsoDate(isoDateTime: string): string {
  return isoDateTime.slice(0, 10);
}

function isValidIsoDateTime(value: string | undefined | null): value is string {
  if (!value) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime());
}

/** NFR-3: structured JSON logging, same shape convention as
 *  packages/graph-db's logOperation / packages/audit-ledger's
 *  logOperation. Never throws. */
function logOperation(input: {
  operation: string;
  entityType?: string;
  entityId?: string;
  outcome: "success" | "error";
  durationMs: number;
  detail?: Record<string, unknown>;
}): void {
  try {
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: input.outcome === "error" ? "error" : "info", ...input }));
  } catch {
    // Logging must never break a write path.
  }
}

/** FR-3's defensive invariant: this unit's graph-write capability MUST
 *  only ever be invoked with a CommitPlan whose `nodes` object has at
 *  most one of `humanReviews`/`evidenceArtifacts` populated, no other
 *  `nodes.*` key, and no `supersessions` entry. Called immediately
 *  before every `ctx.graphWriter.commitProposal` call this unit makes. */
function assertNarrowCommitPlan(plan: CommitPlan): void {
  const populatedKeys = (Object.keys(plan.nodes) as (keyof CommitPlan["nodes"])[]).filter((key) => {
    const value = plan.nodes[key];
    return Array.isArray(value) && value.length > 0;
  });

  const allowedKeys = new Set(["humanReviews", "evidenceArtifacts"]);
  const disallowedKeys = populatedKeys.filter((key) => !allowedKeys.has(key));
  if (disallowedKeys.length > 0) {
    throw new MonitoringAuditInvariantError(
      `CommitPlan populated a disallowed nodes.* key for this unit: ${disallowedKeys.join(", ")}. ` +
        "Monitoring and Audit may only write nodes.humanReviews or nodes.evidenceArtifacts (§1's documented exception)."
    );
  }
  if (populatedKeys.length > 1) {
    throw new MonitoringAuditInvariantError(
      `CommitPlan populated more than one of nodes.humanReviews/nodes.evidenceArtifacts: ${populatedKeys.join(", ")}.`
    );
  }
  if (plan.supersessions && plan.supersessions.length > 0) {
    throw new MonitoringAuditInvariantError("CommitPlan must never include a supersessions entry (FR-3).");
  }
}

// ---------------------------------------------------------------------------
// SLA / ProcessTask fulfilment monitoring (FR-4–FR-10)
// ---------------------------------------------------------------------------

/** FR-4: task.valid_from + task.sla_hours hours, as an ISO datetime. */
export function computeTaskDeadline(task: ProcessTask): string {
  const validFromMs = new Date(task.valid_from).getTime();
  const deadlineMs = validFromMs + task.sla_hours * 60 * 60 * 1000;
  return new Date(deadlineMs).toISOString();
}

function hoursBetween(fromIso: string, toIso: string): number {
  return (new Date(toIso).getTime() - new Date(fromIso).getTime()) / (1000 * 60 * 60);
}

/** FR-5's `hoursElapsedRatio`. FR-6: never divides by zero — when
 *  `sla_hours <= 0`, returns raw hours elapsed (0 if none has) instead of
 *  a true ratio; this value is informational only in that case (the
 *  status decision below does not depend on it). */
export function computeHoursElapsedRatio(task: ProcessTask, referenceDate: string): number {
  const hoursElapsed = hoursBetween(task.valid_from, referenceDate);
  if (task.sla_hours <= 0) {
    return hoursElapsed > 0 ? hoursElapsed : 0;
  }
  return hoursElapsed / task.sla_hours;
}

function earliestUploadedAt(artifacts: EvidenceArtifact[]): string {
  return artifacts.reduce((earliest, artifact) =>
    new Date(artifact.uploaded_at).getTime() < new Date(earliest.uploaded_at).getTime() ? artifact : earliest
  ).uploaded_at;
}

function latestUploadedAt(artifacts: EvidenceArtifact[]): string {
  return artifacts.reduce((latest, artifact) =>
    new Date(artifact.uploaded_at).getTime() > new Date(latest.uploaded_at).getTime() ? artifact : latest
  ).uploaded_at;
}

/** FR-5/FR-6: precedence order — fulfilled (on time or late) beats
 *  breached/approaching/on_track; `sla_hours <= 0` short-circuits to
 *  already-breached (or fulfilled_late) before any ratio/deadline
 *  comparison, per FR-6. */
export function classifySlaStatus(task: ProcessTask, evidenceArtifacts: EvidenceArtifact[], referenceDate: string): SlaStatus {
  if (task.sla_hours <= 0) {
    return evidenceArtifacts.length > 0 ? "fulfilled_late" : "breached_unfulfilled";
  }

  const deadline = computeTaskDeadline(task);
  const deadlineMs = new Date(deadline).getTime();

  if (evidenceArtifacts.length > 0) {
    const earliest = earliestUploadedAt(evidenceArtifacts);
    return new Date(earliest).getTime() <= deadlineMs ? "fulfilled_on_time" : "fulfilled_late";
  }

  if (new Date(referenceDate).getTime() > deadlineMs) {
    return "breached_unfulfilled";
  }

  const ratio = computeHoursElapsedRatio(task, referenceDate);
  // A ratio computed via two chained floating-point divisions (ms diff ->
  // hours -> /sla_hours) can land a few ULPs below a mathematically exact
  // 0.8 (e.g. 0.7999999999999999) even when the wall-clock inputs are
  // exact — a tiny epsilon avoids spuriously missing the approaching
  // threshold right at the boundary FR-5 explicitly calls out.
  const RATIO_EPSILON = 1e-9;
  if (ratio >= SLA_APPROACHING_THRESHOLD_RATIO - RATIO_EPSILON) {
    return "approaching";
  }
  return "on_track";
}

interface ProcessTaskGapRow {
  t: unknown;
  evidenceArtifacts: unknown[];
}

/** FR-8/FR-9: appends an SLA_APPROACHING/SLA_BREACHED ledger entry only
 *  on a state *transition* into that status, using
 *  `ctx.ledger.getLatestEntryForEntity` to detect whether the latest
 *  recorded status-class for this task already matches. FR-10: the
 *  breached -> fulfilled_late transition is intentionally not handled
 *  here (ingestEvidenceArtifact's own ledger entry already covers it). */
async function maybeAppendSlaTransitionEntry(report: SlaGapReport, ctx: MonitoringAuditContext): Promise<void> {
  const targetEventType: "SLA_APPROACHING" | "SLA_BREACHED" | null =
    report.status === "approaching" ? "SLA_APPROACHING" : report.status === "breached_unfulfilled" ? "SLA_BREACHED" : null;
  if (!targetEventType) {
    return;
  }

  const latest = await ctx.ledger.getLatestEntryForEntity("ProcessTask", report.task_id, ["SLA_APPROACHING", "SLA_BREACHED"]);
  if (latest && latest.event_type === targetEventType) {
    return; // FR-9: no state transition since the last recorded entry.
  }

  await appendLedgerEntry(
    {
      event_type: targetEventType,
      actor: { type: "system", id: "sla-scan-cron" },
      entity_ref: { entity_type: "ProcessTask", entity_id: report.task_id },
      payload: { ...report }
    },
    ctx
  );
}

/** FR-7: queries all "live" ProcessTasks and classifies each — including
 *  on_track/fulfilled_on_time, so callers can render full queue state.
 *  §8: a read timeout logs a warning and returns an empty (degraded)
 *  result rather than throwing — a partial/empty scan this cycle is
 *  preferable to failing the whole caller. A malformed individual row
 *  (missing task_id/valid_from) is skipped with an error log, not fatal
 *  to the rest of the scan. */
export async function scanForSlaGaps(ctx: MonitoringAuditContext): Promise<SlaGapReport[]> {
  const start = Date.now();
  const timeoutMs = ctx.graphTimeoutMs ?? DEFAULT_GRAPH_TIMEOUT_MS;

  let rows: ProcessTaskGapRow[];
  try {
    rows = await withTimeout(ctx.graph.runCypher<ProcessTaskGapRow>(SLA_GAP_SCAN_CYPHER, {}), timeoutMs);
  } catch (error) {
    logOperation({
      operation: "scanForSlaGaps",
      outcome: "error",
      durationMs: Date.now() - start,
      detail: { degraded: true, error: error instanceof Error ? error.message : String(error) }
    });
    return [];
  }

  const reports: SlaGapReport[] = [];
  for (const row of rows) {
    const task = unwrapNodeProperties<ProcessTask>(row.t);
    if (!task || !task.task_id || !task.valid_from || task.obligation_id === undefined) {
      logOperation({
        operation: "scanForSlaGaps",
        outcome: "error",
        durationMs: 0,
        detail: { reason: "malformed ProcessTask row, skipped", row }
      });
      continue;
    }

    const evidenceArtifacts = (row.evidenceArtifacts ?? [])
      .map((entry) => unwrapNodeProperties<EvidenceArtifact>(entry))
      .filter((entry): entry is EvidenceArtifact => Boolean(entry));

    const report: SlaGapReport = {
      task_id: task.task_id,
      obligation_id: task.obligation_id,
      owner_role: task.owner_role,
      deadline: computeTaskDeadline(task),
      status: classifySlaStatus(task, evidenceArtifacts, ctx.referenceDate),
      hoursElapsedRatio: computeHoursElapsedRatio(task, ctx.referenceDate),
      hasEvidence: evidenceArtifacts.length > 0,
      latestEvidenceUploadedAt: evidenceArtifacts.length > 0 ? latestUploadedAt(evidenceArtifacts) : null
    };
    reports.push(report);

    await maybeAppendSlaTransitionEntry(report, ctx);
  }

  logOperation({ operation: "scanForSlaGaps", outcome: "success", durationMs: Date.now() - start, detail: { taskCount: reports.length } });
  return reports;
}

// ---------------------------------------------------------------------------
// Evidence ingestion and hash validation (FR-11–FR-18)
// ---------------------------------------------------------------------------

/** FR-11: lowercase hex SHA-256 digest of the exact bytes passed in — no
 *  normalization, no encoding transformation. Pure/sync (FR-2/NFR-8). */
export function computeFileHash(file: Buffer): string {
  return createHash("sha256").update(file).digest("hex");
}

/** FR-12–FR-18. See NFR-4 for the graph-write-before-ledger-write
 *  ordering this function (and recordHumanReview) must preserve. */
export async function ingestEvidenceArtifact(
  input: EvidenceArtifactUploadInput,
  ctx: MonitoringAuditContext
): Promise<EvidenceIngestResult> {
  const start = Date.now();

  if (!input.task_id || input.task_id.trim().length === 0) {
    throw new ValidationError("task_id is required.", "task_id");
  }
  // NFR-6: oversized uploads rejected before hashing begins.
  if (input.file.byteLength > MAX_EVIDENCE_FILE_SIZE_BYTES) {
    throw new ValidationError(`file exceeds the ${MAX_EVIDENCE_FILE_SIZE_BYTES}-byte cap.`, "file");
  }

  const timeoutMs = ctx.graphTimeoutMs ?? DEFAULT_GRAPH_TIMEOUT_MS;

  // FR-18: task_id must resolve to an existing ProcessTask, checked
  // before any hashing/writing.
  const taskRows = await withTimeout(ctx.graph.runCypher(TASK_EXISTS_CYPHER, { taskId: input.task_id }), timeoutMs);
  if (taskRows.length === 0) {
    throw new ValidationError(`ProcessTask "${input.task_id}" does not exist.`, "task_id");
  }

  // FR-11/FR-12: server-computed hash is the only source of truth.
  const computedHash = computeFileHash(input.file);
  const uploadedAt = input.uploadedAt ?? ctx.referenceDate;

  // FR-13: claimed-hash mismatch — reject the artifact, still ledger-log
  // the attempt (FR-16/FR-17).
  if (input.claimedHash && input.claimedHash.toLowerCase() !== computedHash.toLowerCase()) {
    const ledgerEntry = await appendLedgerEntry(
      {
        event_type: "EVIDENCE_HASH_MISMATCH",
        actor: { type: "human", id: input.uploaded_by },
        entity_ref: { entity_type: "ProcessTask", entity_id: input.task_id },
        payload: {
          task_id: input.task_id,
          claimedHash: input.claimedHash,
          computedHash,
          uploaded_by: input.uploaded_by
        }
      },
      ctx
    );
    logOperation({ operation: "ingestEvidenceArtifact", entityType: "ProcessTask", entityId: input.task_id, outcome: "success", durationMs: Date.now() - start, detail: { outcome: "hash_mismatch" } });
    return { outcome: "hash_mismatch", evidenceArtifact: null, computedHash, ledgerEntry };
  }

  // FR-15: duplicate-hash-on-same-task check, scoped to task_id (a
  // matching hash on a *different* task is NOT a duplicate).
  const duplicateRows = await withTimeout(
    ctx.graph.runCypher<{ e: unknown }>(DUPLICATE_EVIDENCE_HASH_CYPHER, { taskId: input.task_id, computedHash }),
    timeoutMs
  );
  if (duplicateRows.length > 0) {
    const existing = unwrapNodeProperties<EvidenceArtifact>(duplicateRows[0].e);
    if (!existing) {
      throw new ValidationError("Duplicate-hash query returned a malformed EvidenceArtifact row.", "task_id");
    }
    const ledgerEntry = await appendLedgerEntry(
      {
        event_type: "EVIDENCE_ARTIFACT_INGESTED",
        actor: { type: "human", id: input.uploaded_by },
        entity_ref: { entity_type: "EvidenceArtifact", entity_id: existing.evidence_id },
        payload: {
          task_id: input.task_id,
          type: input.type,
          computedHash,
          uploaded_by: input.uploaded_by,
          uploaded_at: uploadedAt,
          duplicateOf: existing.evidence_id
        }
      },
      ctx
    );
    logOperation({ operation: "ingestEvidenceArtifact", entityType: "EvidenceArtifact", entityId: existing.evidence_id, outcome: "success", durationMs: Date.now() - start, detail: { outcome: "duplicate" } });
    return { outcome: "duplicate", evidenceArtifact: existing, computedHash, ledgerEntry };
  }

  // FR-16: the "ingested" path — narrow CommitPlan, graph write before
  // ledger append (NFR-4).
  const evidenceId = randomUUID();
  const plan: CommitPlan = {
    proposalId: `evidence-${evidenceId}`,
    nodes: {
      evidenceArtifacts: [
        {
          evidence_id: evidenceId,
          task_id: input.task_id,
          type: input.type,
          hash: computedHash,
          uploaded_at: uploadedAt,
          uploaded_by: input.uploaded_by,
          valid_from: toIsoDate(uploadedAt),
          valid_to: null
        }
      ]
    },
    edges: [{ type: "EVIDENCED_BY", task_id: input.task_id, evidence_id: evidenceId }]
  };
  // FR-3's defensive invariant check, immediately before the graph write.
  assertNarrowCommitPlan(plan);

  let commitResult: CommitResult;
  try {
    commitResult = await ctx.graphWriter.commitProposal(plan);
  } catch (error) {
    logOperation({
      operation: "ingestEvidenceArtifact",
      entityType: "ProcessTask",
      entityId: input.task_id,
      outcome: "error",
      durationMs: Date.now() - start
    });
    throw error; // NFR-4: graph write failed -> no ledger entry for this attempt.
  }

  const evidenceArtifact: EvidenceArtifact = {
    evidence_id: evidenceId,
    task_id: input.task_id,
    type: input.type,
    hash: computedHash,
    uploaded_at: uploadedAt,
    uploaded_by: input.uploaded_by,
    valid_from: toIsoDate(uploadedAt),
    valid_to: null,
    recorded_at: commitResult.committedAt
  };

  const ledgerEntry = await appendLedgerEntry(
    {
      event_type: "EVIDENCE_ARTIFACT_INGESTED",
      actor: { type: "human", id: input.uploaded_by },
      entity_ref: { entity_type: "EvidenceArtifact", entity_id: evidenceId },
      payload: {
        task_id: input.task_id,
        evidence_id: evidenceId,
        type: input.type,
        computedHash,
        uploaded_by: input.uploaded_by,
        uploaded_at: uploadedAt,
        // §8: a zero-byte file is accepted (hashing an empty buffer is
        // well-defined); flagged here for a later reviewer to judge
        // sufficiency, not rejected as an integrity error.
        fileSizeBytes: input.file.byteLength
      }
    },
    ctx
  );

  logOperation({
    operation: "ingestEvidenceArtifact",
    entityType: "EvidenceArtifact",
    entityId: evidenceId,
    outcome: "success",
    durationMs: Date.now() - start,
    detail: { outcome: "ingested" }
  });

  return { outcome: "ingested", evidenceArtifact, computedHash, ledgerEntry };
}

// ---------------------------------------------------------------------------
// HumanReview recording — the graph-write exception (FR-19–FR-28)
// ---------------------------------------------------------------------------

/** FR-26: Tier B (1 review) resolves directly from the single decision;
 *  Tier C resolves from first-vs-second-review agreement/disagreement.
 *  `allReviews` MUST be in submission order. */
function computeReviewOutcome(tier: ReviewTier, allReviews: HumanReview[]): ReviewOutcome {
  if (tier === "B") {
    return allReviews[allReviews.length - 1].decision === "approve" ? "APPROVED" : "REJECTED";
  }
  if (allReviews.length === 1) {
    return "AWAITING_SECOND_REVIEWER";
  }
  const [first, second] = allReviews;
  if (first.decision === second.decision) {
    return first.decision === "approve" ? "APPROVED" : "REJECTED";
  }
  return "ESCALATED_DISAGREEMENT";
}

/** FR-19–FR-28. Validation order is load-bearing (§10/§11 task 10):
 *  FR-24's idempotency check runs FIRST (before FR-23's same-reviewer
 *  check) so a genuine retry of the same event_id is never mistaken for
 *  a same-reviewer violation. This function (and getReviewsVisibleTo)
 *  are the ONLY code paths in the system permitted to read or write
 *  HumanReview data — see docs/specs/README.md's "Known cross-spec gaps"
 *  CRITICAL-RESOLVED item this spec's §4 doc comment references. */
export async function recordHumanReview(event: HumanReviewSubmittedEvent, ctx: MonitoringAuditContext): Promise<RecordHumanReviewResult> {
  const start = Date.now();

  // FR-19: Tier A has no human review step by definition.
  if (event.tier === "A") {
    throw new ValidationError('HumanReview is not applicable to Tier A ("A" has no human review step by definition).', "tier");
  }

  // FR-20: basic validation, before any graph/ledger interaction.
  if (event.decision !== "approve" && event.decision !== "reject") {
    throw new ValidationError('decision must be exactly "approve" or "reject".', "decision");
  }
  if (!event.obligation_id || event.obligation_id.trim().length === 0) {
    throw new ValidationError("obligation_id is required.", "obligation_id");
  }
  if (!event.reviewer_id || event.reviewer_id.trim().length === 0) {
    throw new ValidationError("reviewer_id is required.", "reviewer_id");
  }

  // FR-22: Tier C requires a non-empty, non-whitespace-only rationale.
  if (event.tier === "C" && (!event.rationale || event.rationale.trim().length === 0)) {
    throw new ValidationError("rationale is required and must be non-empty at Tier C.", "rationale");
  }

  // FR-21: default decided_at to ctx.referenceDate if absent/malformed.
  const decidedAt = isValidIsoDateTime(event.decided_at) ? event.decided_at : ctx.referenceDate;

  const timeoutMs = ctx.graphTimeoutMs ?? DEFAULT_GRAPH_TIMEOUT_MS;

  // FR-24: idempotency check FIRST. AuditLedgerPort has no
  // search-by-payload-field primitive, so this queries every
  // HUMAN_REVIEW_SUBMITTED entry related to this obligation (via
  // queryLedger's entityType: "Obligation" join over the ledger's
  // denormalized related_obligation_id column, see
  // @sentinel-act/audit-ledger's PostgresAuditLedger.query) and filters
  // in-memory for a matching event_id.
  const priorSubmissions = await ctx.ledger.query({
    entityType: "Obligation",
    entityId: event.obligation_id,
    eventTypes: ["HUMAN_REVIEW_SUBMITTED"],
    limit: 1000
  });
  const priorMatch = priorSubmissions.find((entry) => entry.payload.event_id === event.event_id);
  if (priorMatch) {
    logOperation({
      operation: "recordHumanReview",
      entityType: "Obligation",
      entityId: event.obligation_id,
      outcome: "success",
      durationMs: Date.now() - start,
      detail: { idempotentReplay: true, event_id: event.event_id }
    });
    return {
      humanReview: priorMatch.payload.humanReview as HumanReview,
      reviewOutcome: priorMatch.payload.reviewOutcome as ReviewOutcome,
      allReviewsForObligation: priorMatch.payload.allReviewsForObligation as HumanReview[],
      ledgerEntry: priorMatch
    };
  }

  // FR-23: fetch existing reviews. §8: this lookup timing out MUST fail
  // the whole call (throw, no write) — acting on stale/incomplete
  // review-count data risks violating the maker-checker rules.
  const reviewRows = await withTimeout(
    ctx.graph.runCypher<{ obligationStatus: string; existingReviews: unknown[] }>(OBLIGATION_REVIEWS_CYPHER, {
      obligationId: event.obligation_id
    }),
    timeoutMs
  );
  const existingReviews = (reviewRows[0]?.existingReviews ?? [])
    .map((entry) => unwrapNodeProperties<HumanReview>(entry))
    .filter((entry): entry is HumanReview => Boolean(entry));

  if (existingReviews.some((review) => review.reviewer_id === event.reviewer_id)) {
    throw new SameReviewerNotAllowedError(
      `reviewer "${event.reviewer_id}" has already submitted a decision for obligation "${event.obligation_id}".`
    );
  }

  const requiredReviewCount = event.tier === "C" ? 2 : 1;
  if (existingReviews.length >= requiredReviewCount) {
    throw new ReviewAlreadyCompleteError(`obligation "${event.obligation_id}" already has ${requiredReviewCount} review(s) recorded.`);
  }

  // FR-25: narrow CommitPlan.
  const reviewId = randomUUID();
  const plan: CommitPlan = {
    proposalId: `human-review-${reviewId}`,
    nodes: {
      humanReviews: [
        {
          review_id: reviewId,
          obligation_id: event.obligation_id,
          reviewer_id: event.reviewer_id,
          tier: event.tier,
          decision: event.decision,
          rationale: event.rationale,
          decided_at: decidedAt,
          valid_from: toIsoDate(decidedAt),
          valid_to: null
        }
      ]
    },
    edges: [{ type: "REVIEWED_BY", obligation_id: event.obligation_id, review_id: reviewId }]
  };
  // FR-3's defensive invariant check, immediately before the graph write.
  assertNarrowCommitPlan(plan);

  let commitResult: CommitResult;
  try {
    commitResult = await ctx.graphWriter.commitProposal(plan);
  } catch (error) {
    logOperation({
      operation: "recordHumanReview",
      entityType: "Obligation",
      entityId: event.obligation_id,
      outcome: "error",
      durationMs: Date.now() - start
    });
    throw error; // NFR-4: graph write failed -> no ledger entry for this attempt.
  }

  const newReview: HumanReview = {
    review_id: reviewId,
    obligation_id: event.obligation_id,
    reviewer_id: event.reviewer_id,
    tier: event.tier,
    decision: event.decision,
    rationale: event.rationale,
    decided_at: decidedAt,
    valid_from: toIsoDate(decidedAt),
    valid_to: null,
    recorded_at: commitResult.committedAt
  };

  const allReviewsForObligation = [...existingReviews, newReview];
  const reviewOutcome = computeReviewOutcome(event.tier, allReviewsForObligation);

  // FR-27: the ledger entry's payload carries the full event plus the
  // computed outcome and the resulting HumanReview/review-set, so (a)
  // Spec 10's export needs no graph join, and (b) FR-24's idempotent
  // replay above can reconstruct the full RecordHumanReviewResult from
  // this entry alone.
  const ledgerEntry = await appendLedgerEntry(
    {
      event_type: "HUMAN_REVIEW_SUBMITTED",
      actor: { type: "human", id: event.reviewer_id },
      entity_ref: { entity_type: "HumanReview", entity_id: reviewId },
      payload: {
        event_id: event.event_id,
        obligation_id: event.obligation_id,
        reviewer_id: event.reviewer_id,
        tier: event.tier,
        decision: event.decision,
        rationale: event.rationale,
        decided_at: decidedAt,
        source: event.source,
        source_ref: event.source_ref,
        reviewOutcome,
        humanReview: newReview,
        allReviewsForObligation
      }
    },
    ctx
  );

  logOperation({
    operation: "recordHumanReview",
    entityType: "HumanReview",
    entityId: reviewId,
    outcome: "success",
    durationMs: Date.now() - start,
    detail: { obligation_id: event.obligation_id, reviewOutcome }
  });

  return { humanReview: newReview, reviewOutcome, allReviewsForObligation, ledgerEntry };
}

/** FR-28: the Tier C independence rule enforced at the data-access
 *  layer. Requester has not yet submitted their own review -> empty
 *  array, regardless of how many other reviews exist (including zero,
 *  which is also just an empty array, not an error). Requester has
 *  submitted -> every review, unredacted. */
export async function getReviewsVisibleTo(
  obligationId: string,
  requestingReviewerId: string,
  ctx: MonitoringAuditContext
): Promise<HumanReview[]> {
  const timeoutMs = ctx.graphTimeoutMs ?? DEFAULT_GRAPH_TIMEOUT_MS;
  const rows = await withTimeout(
    ctx.graph.runCypher<{ obligationStatus: string; existingReviews: unknown[] }>(OBLIGATION_REVIEWS_CYPHER, { obligationId }),
    timeoutMs
  );
  const reviews = (rows[0]?.existingReviews ?? [])
    .map((entry) => unwrapNodeProperties<HumanReview>(entry))
    .filter((entry): entry is HumanReview => Boolean(entry));

  const hasOwnReview = reviews.some((review) => review.reviewer_id === requestingReviewerId);
  return hasOwnReview ? reviews : [];
}

// ---------------------------------------------------------------------------
// Ledger wrapper functions (FR-29 — appendLedgerEntry is the sole
// ledger-store insert path; this unit's own callers above all funnel
// through it, matching Spec 08's own convention for its ledger writes)
// ---------------------------------------------------------------------------

// §8's failure-mode table: "Ledger (Postgres) unavailable when
// appendLedgerEntry is called, after a successful graph write ...
// appendLedgerEntry retries with bounded backoff (e.g. 3 attempts)."
const LEDGER_APPEND_MAX_ATTEMPTS = 3;
const LEDGER_APPEND_RETRY_DELAY_MS = 50;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** §8: bounded-retry wrapper around `ctx.ledger.append`. If all attempts
 *  fail, this function logs CRITICAL and re-throws rather than
 *  fabricating a `LedgerEntry` (its `sequence_number`/hash chain can
 *  only be assigned by a real, successful append) — callers
 *  (`ingestEvidenceArtifact`/`recordHumanReview`) therefore still
 *  propagate the failure even though the *graph* write they made just
 *  before calling this already durably succeeded (NFR-4's "graph
 *  committed, ledger lagging" case). `reconcileLedgerGaps` (§11 task 12)
 *  is the mechanism that later backfills the missing ledger entry for
 *  that already-durable graph fact — see its own doc comment. */
export async function appendLedgerEntry(input: LedgerAppendInput, ctx: MonitoringAuditContext): Promise<LedgerEntry> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= LEDGER_APPEND_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await ctx.ledger.append(input);
    } catch (error) {
      lastError = error;
      if (attempt < LEDGER_APPEND_MAX_ATTEMPTS) {
        await delay(LEDGER_APPEND_RETRY_DELAY_MS);
      }
    }
  }

  logOperation({
    operation: "appendLedgerEntry",
    entityType: input.entity_ref.entity_type ?? undefined,
    entityId: input.entity_ref.entity_id ?? undefined,
    outcome: "error",
    durationMs: 0,
    detail: { attempts: LEDGER_APPEND_MAX_ATTEMPTS, event_type: input.event_type, critical: true }
  });
  throw lastError;
}

/** Thin delegate to `ctx.ledger.verifyChainIntegrity` — FR-33–FR-36's
 *  actual walk/break-detection/side-channel-alerting logic lives in
 *  `@sentinel-act/audit-ledger`'s `PostgresAuditLedger` (the concrete
 *  `AuditLedgerPort` implementation), which is also where the passing-run
 *  CHAIN_VERIFICATION_RUN entry gets appended (via that same class's own
 *  `append()` — the one ledger-store insert path, FR-29). */
export async function verifyChainIntegrity(
  range: { fromSequence?: number; toSequence?: number } | undefined,
  ctx: MonitoringAuditContext
): Promise<ChainVerificationResult> {
  return ctx.ledger.verifyChainIntegrity(range);
}

// ---------------------------------------------------------------------------
// Compliance Register Export feed (FR-38/FR-39)
// ---------------------------------------------------------------------------

export async function queryLedger(query: LedgerQuery, ctx: MonitoringAuditContext): Promise<LedgerEntry[]> {
  return ctx.ledger.query(query);
}

/** FR-39: equivalent to `queryLedger({ entityType: "Obligation",
 *  entityId: obligationId, toTimestamp })` — the join across
 *  HumanReview/EvidenceArtifact entries whose own `entity_ref` doesn't
 *  point at the Obligation directly is implemented inside
 *  `PostgresAuditLedger.query` via the denormalized
 *  `related_obligation_id` column (populated at append time), so this
 *  function is a thin, literal delegate as the spec's wording states —
 *  see packages/audit-ledger/src/postgres-audit-ledger.ts's `query()` doc
 *  comment for the exact join strategy. */
export async function getObligationAuditTrail(
  obligationId: string,
  ctx: MonitoringAuditContext,
  opts?: { asOfTimestamp?: string }
): Promise<LedgerEntry[]> {
  return ctx.ledger.query({
    entityType: "Obligation",
    entityId: obligationId,
    toTimestamp: opts?.asOfTimestamp,
    limit: 1000
  });
}

// ---------------------------------------------------------------------------
// Reconciliation sweep (§8's failure-mode row, §11 task 12, Acceptance
// Criterion 8) — a scheduled job that finds HumanReview/EvidenceArtifact
// graph nodes with no matching ledger entry (the "graph committed, ledger
// append failed after the fact" case NFR-4 anticipates) and backfills a
// ledger entry for each, tagged so the backfill is itself auditable and
// never confused with the original event time.
// ---------------------------------------------------------------------------

const RECENT_HUMAN_REVIEWS_CYPHER = `
  MATCH (o:Obligation)-[:REVIEWED_BY]->(r:HumanReview)
  WHERE r.recorded_at >= datetime($sinceTimestamp)
  RETURN r, o.obligation_id AS obligationId
`;

const RECENT_EVIDENCE_ARTIFACTS_CYPHER = `
  MATCH (t:ProcessTask)-[:EVIDENCED_BY]->(e:EvidenceArtifact)
  WHERE e.recorded_at >= datetime($sinceTimestamp)
  RETURN e, t.task_id AS taskId
`;

export interface ReconciliationSweepResult {
  checked: number;
  backfilled: number;
  backfilledEntityIds: string[];
}

/** Default lookback window when `opts.sinceTimestamp` is not supplied —
 *  a placeholder pending ops sign-off, same status as this unit's other
 *  cadence constants (§13). */
const RECONCILIATION_DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** Compares recently-created HumanReview/EvidenceArtifact graph nodes
 *  against the ledger and backfills a ledger entry for any that have
 *  none. Every backfilled entry's payload carries `{ backfilled: true,
 *  originalEventTime }` (the node's own `recorded_at`) so the ledger's
 *  own `timestamp` — when the gap was *discovered* — is never confused
 *  with when the event actually occurred. Uses `appendLedgerEntry`, the
 *  one ledger-store insert path (FR-29), same as every other write in
 *  this unit. */
export async function reconcileLedgerGaps(
  ctx: MonitoringAuditContext,
  opts?: { sinceTimestamp?: string }
): Promise<ReconciliationSweepResult> {
  const start = Date.now();
  const since = opts?.sinceTimestamp ?? new Date(new Date(ctx.referenceDate).getTime() - RECONCILIATION_DEFAULT_LOOKBACK_MS).toISOString();
  const timeoutMs = ctx.graphTimeoutMs ?? DEFAULT_GRAPH_TIMEOUT_MS;

  let checked = 0;
  const backfilledEntityIds: string[] = [];

  const reviewRows = await withTimeout(
    ctx.graph.runCypher<{ r: unknown; obligationId: string }>(RECENT_HUMAN_REVIEWS_CYPHER, { sinceTimestamp: since }),
    timeoutMs
  );
  for (const row of reviewRows) {
    const review = unwrapNodeProperties<HumanReview>(row.r);
    if (!review) {
      continue;
    }
    checked += 1;
    const existing = await ctx.ledger.query({
      entityType: "HumanReview",
      entityId: review.review_id,
      eventTypes: ["HUMAN_REVIEW_SUBMITTED"],
      limit: 1
    });
    if (existing.length > 0) {
      continue;
    }
    await appendLedgerEntry(
      {
        event_type: "HUMAN_REVIEW_SUBMITTED",
        actor: { type: "system", id: "reconciliation-sweep" },
        entity_ref: { entity_type: "HumanReview", entity_id: review.review_id },
        payload: {
          obligation_id: row.obligationId,
          reviewer_id: review.reviewer_id,
          tier: review.tier,
          decision: review.decision,
          rationale: review.rationale,
          decided_at: review.decided_at,
          humanReview: review,
          backfilled: true,
          originalEventTime: review.recorded_at
        }
      },
      ctx
    );
    backfilledEntityIds.push(review.review_id);
  }

  const evidenceRows = await withTimeout(
    ctx.graph.runCypher<{ e: unknown; taskId: string }>(RECENT_EVIDENCE_ARTIFACTS_CYPHER, { sinceTimestamp: since }),
    timeoutMs
  );
  for (const row of evidenceRows) {
    const evidence = unwrapNodeProperties<EvidenceArtifact>(row.e);
    if (!evidence) {
      continue;
    }
    checked += 1;
    const existing = await ctx.ledger.query({
      entityType: "EvidenceArtifact",
      entityId: evidence.evidence_id,
      eventTypes: ["EVIDENCE_ARTIFACT_INGESTED"],
      limit: 1
    });
    if (existing.length > 0) {
      continue;
    }
    await appendLedgerEntry(
      {
        event_type: "EVIDENCE_ARTIFACT_INGESTED",
        actor: { type: "system", id: "reconciliation-sweep" },
        entity_ref: { entity_type: "EvidenceArtifact", entity_id: evidence.evidence_id },
        payload: {
          task_id: row.taskId,
          type: evidence.type,
          computedHash: evidence.hash,
          uploaded_by: evidence.uploaded_by,
          uploaded_at: evidence.uploaded_at,
          backfilled: true,
          originalEventTime: evidence.recorded_at
        }
      },
      ctx
    );
    backfilledEntityIds.push(evidence.evidence_id);
  }

  logOperation({
    operation: "reconcileLedgerGaps",
    outcome: "success",
    durationMs: Date.now() - start,
    detail: { checked, backfilled: backfilledEntityIds.length }
  });

  return { checked, backfilled: backfilledEntityIds.length, backfilledEntityIds };
}

// ---------------------------------------------------------------------------
// Agent export (§5.1) — { name, description, run } shape, run wraps
// scanForSlaGaps (its periodic/default action), the rest of §5.1's
// functions are named exports the Orchestrator/Spec 09/Spec 11 import
// directly.
// ---------------------------------------------------------------------------

export const monitoringAndAuditAgent = {
  name: "monitoring-and-audit",
  description: "Tracks ProcessTask fulfilment and evidence, logs HumanReview decisions to the hash-chained Audit Ledger.",
  run: scanForSlaGaps
};
