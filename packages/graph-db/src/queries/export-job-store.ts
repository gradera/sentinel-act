// ExportJobStore — Spec 10 §5.4. Backs :ExportJob nodes: the ONE non-
// canonical, infra-only Neo4j label this Spec 10 unit owns (same
// precedent as Spec 01's `:SchemaMigration` (migrations/runner.ts) /
// `:CommitLog` (commit/graph-writer.ts) — see this spec's §6, §13 Open
// Question 1, and Spec 01 §5.4's own use of that precedent). An
// :ExportJob node is operational bookkeeping for the async export
// lifecycle (FR-12/FR-13) — it is NOT a Regulatory Knowledge Graph fact
// (Obligation/Circular/Clause/ProcessTask/HumanReview/IntermediaryCategory
// or the RegulatoryEntity roll-up), so writing/deleting it does not
// violate this package's "audit surfaces never write to the graph"
// invariant (FR-21, enforced elsewhere for audit-query.ts). That
// invariant is about the *regulatory record* staying append-only and
// reviewer-gated; an :ExportJob is just "did this PDF/XLSX generation
// finish yet," exactly like `:SchemaMigration` tracks "did this migration
// file run yet" — nobody would call runMigrations() a violation of the
// graph's write discipline, and the same reasoning applies here.
//
// ***** Load-bearing for a later stage (task #12, the ESLint *****
// ***** no-restricted-imports guard) *****
//
// This file is the ONLY module under packages/graph-db/src/queries/ that
// calls `session.executeWrite` (in markRunning/markCompleted/markFailed/
// deleteExpired below) — audit-query.ts is 100% executeRead, by design
// and by its own top-of-file comment. A future ESLint rule that forbids
// `executeWrite`/repository write-method imports from
// apps/web-console's observer/audit route tree MUST treat
// export-job-store.ts as a narrow, intentional exception (its writes
// touch only `:ExportJob` nodes, never a canonical label) rather than
// flag it as a violation of the same read-only rule audit-query.ts
// follows. Do not "fix" this file to be read-only-everywhere — that
// would make FR-13/FR-16 impossible to implement at all.
import { randomUUID } from "node:crypto";
import type { Driver } from "neo4j-driver";
import { getSingletonDatabase } from "../driver.js";
import { NotFoundError } from "../errors.js";
import { logOperation } from "../logger.js";
import { serializeProperties } from "../repositories/serialize.js";
import type {
  ComplianceRegisterExportJob,
  ComplianceRegisterExportRequest,
  ExportFormat,
  ExportJobStatus
} from "./audit-query.types.js";

const LABEL = "ExportJob";

// FR-16: 7-day default retention window, applied server-side (DB clock)
// at create() time so `expiresAt` is always DB-derived, matching
// `requestedAt`'s own "DB-clock-derived" contract (audit-query.types.ts).
const DEFAULT_RETENTION_DAYS = 7;

// Fields that Neo4j silently drops (rather than storing a null value)
// when absent — see repositories/serialize.ts's doc comment for the full
// explanation of this driver behavior. Every :ExportJob field that is
// `T | null` in ComplianceRegisterExportJob must be listed here so a
// freshly-created ("queued") job's not-yet-set fields deserialize back
// as `null`, not `undefined`.
const EXPORT_JOB_NULLABLE_FIELDS = ["rowCount", "filePath", "fileSizeBytes", "errorMessage", "completedAt", "filtersJson"] as const;

// neo4j-driver's Record#get returns `any` everywhere in this package
// (see audit-query.ts's identical local alias) — matched here rather
// than pulling in the full driver Record generic typing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Neo4jRecord = any;

/**
 * `ComplianceRegisterExportRequest["filters"]` is a nested object
 * (`{ obligationCategory?, intermediaryCategoryName?, tier? }`). Neo4j
 * node properties can only hold primitives or arrays of primitives — no
 * nested maps — so it is stored as a single `filtersJson` string property
 * (JSON.stringify'd) and reconstructed here on read. This is purely a
 * storage-encoding detail internal to this file; every public method's
 * signature still deals in the real `filters` object, never the raw JSON
 * string.
 */
function serializeFilters(filters: ComplianceRegisterExportRequest["filters"]): string | null {
  return filters ? JSON.stringify(filters) : null;
}

function deserializeFilters(filtersJson: unknown): ComplianceRegisterExportRequest["filters"] {
  if (typeof filtersJson !== "string" || filtersJson.length === 0) {
    return undefined;
  }
  return JSON.parse(filtersJson) as ComplianceRegisterExportRequest["filters"];
}

function deserializeExportJob(properties: Record<string, unknown>): ComplianceRegisterExportJob {
  const raw = serializeProperties<Record<string, unknown>>(properties, EXPORT_JOB_NULLABLE_FIELDS);
  return {
    exportId: raw.exportId as string,
    status: raw.status as ExportJobStatus,
    requestedAt: raw.requestedAt as string,
    requestedBy: raw.requestedBy as string,
    asOfDate: raw.asOfDate as string,
    format: raw.format as ExportFormat,
    filters: deserializeFilters(raw.filtersJson),
    rowCount: raw.rowCount as number | null,
    filePath: raw.filePath as string | null,
    fileSizeBytes: raw.fileSizeBytes as number | null,
    errorMessage: raw.errorMessage as string | null,
    completedAt: raw.completedAt as string | null,
    expiresAt: raw.expiresAt as string
  };
}

export class ExportJobStore {
  constructor(private readonly driver: Driver) {}

  private openSession() {
    return this.driver.session({ database: getSingletonDatabase() });
  }

  /** Creates a `:ExportJob` node, status "queued". Returns immediately —
   *  does not run generation itself (§6, FR-12/FR-13's sync-vs-async
   *  decision is the caller's job, not this store's). `exportId` (uuid
   *  v4) is generated here rather than accepted from the caller so no
   *  route handler can ever collide two jobs onto the same id.
   *
   *  This is the one write path in this file besides the mark-status
   *  and deleteExpired transitions below — see this file's top-of-file
   *  comment for why an :ExportJob write is not a violation of the
   *  audit surface's read-only invariant. */
  async create(request: ComplianceRegisterExportRequest): Promise<ComplianceRegisterExportJob> {
    const start = Date.now();
    const exportId = randomUUID();
    const cypher = `CREATE (j:${LABEL})
      SET j.exportId = $exportId,
          j.status = "queued",
          j.requestedAt = datetime(),
          j.requestedBy = $requestedBy,
          j.asOfDate = $asOfDate,
          j.format = $format,
          j.filtersJson = $filtersJson,
          j.rowCount = null,
          j.filePath = null,
          j.fileSizeBytes = null,
          j.errorMessage = null,
          j.completedAt = null,
          j.expiresAt = datetime() + duration({days: $retentionDays})
      RETURN j`;

    const session = this.openSession();
    try {
      const record = await session.executeWrite((tx) =>
        tx.run(cypher, {
          exportId,
          requestedBy: request.requestedBy,
          asOfDate: request.asOfDate,
          format: request.format,
          filtersJson: serializeFilters(request.filters),
          retentionDays: DEFAULT_RETENTION_DAYS
        })
      );
      const job = deserializeExportJob(record.records[0].get("j").properties);
      logOperation({ operation: "create", label: LABEL, durationMs: Date.now() - start, outcome: "success", detail: { exportId } });
      return job;
    } catch (error) {
      logOperation({ operation: "create", label: LABEL, durationMs: Date.now() - start, outcome: "error" });
      throw error;
    } finally {
      await session.close();
    }
  }

  /** Single-node lookup by exportId. Read-only. Backs
   *  GET /api/audit/export/:exportId (the async-path poll target) and
   *  GET /api/audit/export/:exportId/download's expiry check. Returns
   *  null (not an error) when unknown, matching this package's other
   *  findById-style methods (BaseRepository.findById). */
  async find(exportId: string): Promise<ComplianceRegisterExportJob | null> {
    const start = Date.now();
    const cypher = `MATCH (j:${LABEL} {exportId: $exportId}) RETURN j`;
    const session = this.openSession();
    try {
      const result = await session.executeRead((tx) => tx.run(cypher, { exportId }));
      const record = result.records[0];
      const value = record ? deserializeExportJob(record.get("j").properties) : null;
      logOperation({ operation: "find", label: LABEL, durationMs: Date.now() - start, outcome: "success" });
      return value;
    } catch (error) {
      logOperation({ operation: "find", label: LABEL, durationMs: Date.now() - start, outcome: "error" });
      throw error;
    } finally {
      await session.close();
    }
  }

  /** Concurrency-cap helper (NFR-7 / §13 Open Question 8): counts
   *  `:ExportJob` nodes whose status is "queued" or "running" — i.e.
   *  every job that currently occupies a concurrency slot. Read-only.
   *
   *  Design decision: this store owns the Cypher/label knowledge for
   *  `:ExportJob` (matching the rest of this package's "one file per
   *  label" convention), so the count lives here rather than being
   *  reimplemented ad hoc in the API route layer. It deliberately does
   *  NOT read `AUDIT_EXPORT_MAX_CONCURRENT_JOBS` itself and does NOT
   *  decide whether a new job may run — comparing this count against the
   *  configured cap, and deciding to run vs. queue a request, is FR-13's
   *  concern and belongs in the route/background-task layer (a later
   *  Spec 10 stage), not in this storage-only module. Similarly,
   *  `AUDIT_EXPORT_SYNC_ROW_THRESHOLD` (FR-12's sync/async row-count
   *  threshold) has nothing to do with `:ExportJob` bookkeeping at all —
   *  it gates `AuditQueryService`'s row-count estimate, not this store —
   *  so neither env var is read anywhere in this file. */
  async countActiveJobs(): Promise<number> {
    const start = Date.now();
    const cypher = `MATCH (j:${LABEL}) WHERE j.status IN ["queued", "running"] RETURN count(j) AS total`;
    const session = this.openSession();
    try {
      const result = await session.executeRead((tx) => tx.run(cypher, {}));
      const total = result.records[0]?.get("total");
      const count = typeof total === "number" ? total : Number(total?.toNumber?.() ?? total ?? 0);
      logOperation({ operation: "countActiveJobs", label: LABEL, durationMs: Date.now() - start, outcome: "success", detail: { count } });
      return count;
    } catch (error) {
      logOperation({ operation: "countActiveJobs", label: LABEL, durationMs: Date.now() - start, outcome: "error" });
      throw error;
    } finally {
      await session.close();
    }
  }

  /** Transitions a job "queued" -> "running". Write (see top-of-file
   *  comment on why this is an intentional exception to the audit
   *  surface's read-only rule). Throws NotFoundError if exportId does
   *  not exist — a status transition on a job that was never created (or
   *  was already deleteExpired'd) is a caller bug, not a silent no-op. */
  async markRunning(exportId: string): Promise<void> {
    await this.transition(exportId, "markRunning", `SET j.status = "running"`, { exportId });
  }

  /** Transitions a job "running" -> "completed", recording the
   *  generated file's location/size and the final row count (FR-18's
   *  metadata needs `rowCount`; FR-16's cleanup needs `filePath`).
   *  `completedAt` is DB-clock-derived, matching `requestedAt`. Write. */
  async markCompleted(exportId: string, result: { rowCount: number; filePath: string; fileSizeBytes: number }): Promise<void> {
    await this.transition(
      exportId,
      "markCompleted",
      `SET j.status = "completed",
           j.rowCount = $rowCount,
           j.filePath = $filePath,
           j.fileSizeBytes = $fileSizeBytes,
           j.completedAt = datetime()`,
      { exportId, rowCount: result.rowCount, filePath: result.filePath, fileSizeBytes: result.fileSizeBytes }
    );
  }

  /** Transitions a job "queued"/"running" -> "failed" (§8's error table:
   *  "job marked failed with a generic errorMessage ... never left in
   *  running indefinitely"). Also stamps `completedAt` — the interface
   *  comment only says errorMessage is "set only if status === failed,"
   *  it does not restrict completedAt to the success path, and a failed
   *  job has just as definitively "ended" as a completed one (useful for
   *  the same FR-16 cleanup accounting and for surfacing "how long did
   *  this run before it failed" in the UI). Write. */
  async markFailed(exportId: string, errorMessage: string): Promise<void> {
    await this.transition(
      exportId,
      "markFailed",
      `SET j.status = "failed",
           j.errorMessage = $errorMessage,
           j.completedAt = datetime()`,
      { exportId, errorMessage }
    );
  }

  /** Shared guarded-transition helper for markRunning/markCompleted/
   *  markFailed: MATCH by exportId, apply `setClause`, and throw
   *  NotFoundError if nothing matched, so the three public methods above
   *  can't drift out of sync on this behavior. */
  private async transition(exportId: string, operation: string, setClause: string, params: Record<string, unknown>): Promise<void> {
    const start = Date.now();
    const cypher = `MATCH (j:${LABEL} {exportId: $exportId})
      ${setClause}
      RETURN j`;
    const session = this.openSession();
    try {
      const result = await session.executeWrite((tx) => tx.run(cypher, params));
      if (result.records.length === 0) {
        throw new NotFoundError(`ExportJob ${exportId} does not exist — cannot ${operation}.`);
      }
      logOperation({ operation, label: LABEL, durationMs: Date.now() - start, outcome: "success", detail: { exportId } });
    } catch (error) {
      logOperation({ operation, label: LABEL, durationMs: Date.now() - start, outcome: "error" });
      throw error;
    } finally {
      await session.close();
    }
  }

  /** FR-16: deletes every `:ExportJob` node whose `expiresAt` has passed.
   *  Write — this and the three mark* transitions above are the only
   *  writes in this file (see top-of-file comment). Invoked by a
   *  scheduled cleanup task (§6, FR-16), never from request-path code.
   *
   *  `now` is optional and exists specifically so tests (and any caller
   *  that wants a deterministic cutoff) can force the comparison instant
   *  rather than relying on the DB's wall clock; when omitted, the
   *  cutoff is the DB's own `datetime()` (consistent with `requestedAt`/
   *  `expiresAt` themselves being DB-clock-derived, not JS-clock-derived).
   *
   *  Returns `filePaths` alongside `deletedCount` — a deliberate,
   *  documented addition beyond the spec's literal
   *  `Promise<{ deletedCount: number }>` snippet (§5.4): FR-16 also
   *  requires "that also deletes the corresponding file from wherever
   *  FR-12/FR-13 wrote it," but once a node is deleted its `filePath` is
   *  gone from the graph — a caller that only received `deletedCount`
   *  would have no way to know *which* files to delete. Returning the
   *  paths (possibly `null` for a job that never completed, e.g. an
   *  expired "queued"/"failed" job with no file) is the minimal change
   *  that makes FR-16's own file-deletion requirement satisfiable by the
   *  caller; `deletedCount` is kept for exact backward-compatible parity
   *  with the spec's snippet. */
  async deleteExpired(now?: string): Promise<{ deletedCount: number; filePaths: (string | null)[] }> {
    const start = Date.now();
    const cutoffExpr = now !== undefined ? "datetime($now)" : "datetime()";
    const cypher = `MATCH (j:${LABEL})
      WHERE j.expiresAt <= ${cutoffExpr}
      WITH j, j.filePath AS filePath
      DELETE j
      RETURN filePath`;
    const params: Record<string, unknown> = now !== undefined ? { now } : {};

    const session = this.openSession();
    try {
      const result = await session.executeWrite((tx) => tx.run(cypher, params));
      const filePaths = result.records.map((record: Neo4jRecord) => (record.get("filePath") as string | null) ?? null);
      logOperation({ operation: "deleteExpired", label: LABEL, durationMs: Date.now() - start, outcome: "success", detail: { deletedCount: filePaths.length } });
      return { deletedCount: filePaths.length, filePaths };
    } catch (error) {
      logOperation({ operation: "deleteExpired", label: LABEL, durationMs: Date.now() - start, outcome: "error" });
      throw error;
    } finally {
      await session.close();
    }
  }
}
