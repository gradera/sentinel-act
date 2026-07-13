// PostgresAuditLedger — the Postgres-backed AuditLedgerPort
// implementation (Spec 07 §6.5's storage recommendation). One class, one
// pool, mirroring packages/graph-db's "driver singleton, migration
// runner, one class" structure per Spec 07 §6.5.
import type { Pool, PoolClient } from "pg";
import type {
  AuditLedgerPort,
  ChainVerificationResult,
  LedgerActor,
  LedgerAppendInput,
  LedgerEntityRef,
  LedgerEntry,
  LedgerEventType,
  LedgerQuery
} from "./types.js";
import { GENESIS_HASH } from "./types.js";
import { computeEntryHash, computePayloadHash } from "./canonicalize.js";
import { logCritical, logOperation } from "./logger.js";
import { LedgerAppendError } from "./errors.js";

// FR-31: fixed ledger-wide advisory-lock key. Any 64-bit integer works;
// this one is arbitrary but stable across the codebase — never change it
// once deployed, since two different processes must agree on the same
// key to actually serialize against each other.
const LEDGER_ADVISORY_LOCK_KEY = 771_007_001;

// NFR-6: queryLedger's limit is hard-capped server-side regardless of
// what a caller requests.
const DEFAULT_QUERY_LIMIT = 100;
const MAX_QUERY_LIMIT = 1000;

// NFR-2: verifyChainIntegrity paginates in 1,000-row pages.
const VERIFY_PAGE_SIZE = 1000;

interface AuditLedgerRow {
  sequence_number: string | number;
  timestamp: string;
  event_type: string;
  actor_type: string;
  actor_id: string;
  entity_type: string | null;
  entity_id: string | null;
  related_obligation_id: string | null;
  payload: Record<string, unknown>;
  payload_hash: string;
  prev_entry_hash: string;
  entry_hash: string;
}

function rowToLedgerEntry(row: AuditLedgerRow): LedgerEntry {
  return {
    sequence_number: Number(row.sequence_number),
    timestamp: row.timestamp,
    event_type: row.event_type as LedgerEventType,
    actor: { type: row.actor_type as LedgerActor["type"], id: row.actor_id },
    entity_ref: {
      entity_type: (row.entity_type as LedgerEntityRef["entity_type"]) ?? null,
      entity_id: row.entity_id ?? null
    },
    payload: row.payload,
    payload_hash: row.payload_hash,
    prev_entry_hash: row.prev_entry_hash,
    entry_hash: row.entry_hash
  };
}

/** FR-39's chosen join strategy (denormalized column, per §11 task 5 and
 *  §13's recommendation): a row "relates to" Obligation X either because
 *  its own `entity_ref` IS that Obligation, or because its payload
 *  carries `obligation_id: X` even though `entity_ref` points at
 *  something else (a HumanReview's `review_id`, a ProcessTask's
 *  `task_id` via an SlaGapReport payload). Evidence-ingestion payloads
 *  (`EVIDENCE_ARTIFACT_INGESTED`/`EVIDENCE_HASH_MISMATCH`) carry only
 *  `task_id`, not `obligation_id` — resolving those to an obligation
 *  would require a graph join this unit does not perform at ledger-append
 *  time, so `related_obligation_id` is left null for those two event
 *  types. Documented limitation, not a silent gap (mirrors the spec's own
 *  convention of flagging interpretation choices, e.g. §13's SLA-anchor
 *  note). */
function deriveRelatedObligationId(input: LedgerAppendInput): string | null {
  if (input.entity_ref.entity_type === "Obligation" && input.entity_ref.entity_id) {
    return input.entity_ref.entity_id;
  }
  const obligationId = input.payload.obligation_id;
  if (typeof obligationId === "string" && obligationId.length > 0) {
    return obligationId;
  }
  return null;
}

export interface EntryIntegrityCheck {
  ok: boolean;
  reason?: "payload_hash_mismatch" | "entry_hash_mismatch" | "prev_entry_hash_mismatch";
}

/** FR-33's three independent checks for one row, factored out as a pure
 *  function so it is unit-testable without a live Postgres instance —
 *  `verifyChainIntegrity` is just this function applied across a
 *  paginated walk (see below). */
export function checkEntryIntegrity(entry: LedgerEntry, expectedPrevHash: string): EntryIntegrityCheck {
  const recomputedPayloadHash = computePayloadHash(entry.payload);
  if (recomputedPayloadHash !== entry.payload_hash) {
    return { ok: false, reason: "payload_hash_mismatch" };
  }

  const recomputedEntryHash = computeEntryHash({
    sequence_number: entry.sequence_number,
    timestamp: entry.timestamp,
    event_type: entry.event_type,
    payload_hash: entry.payload_hash,
    prev_entry_hash: entry.prev_entry_hash
  });
  if (recomputedEntryHash !== entry.entry_hash) {
    return { ok: false, reason: "entry_hash_mismatch" };
  }

  if (entry.prev_entry_hash !== expectedPrevHash) {
    return { ok: false, reason: "prev_entry_hash_mismatch" };
  }

  return { ok: true };
}

export class PostgresAuditLedger implements AuditLedgerPort {
  constructor(private readonly pool: Pool) {}

  /** FR-29–FR-31: the sole low-level insert path for the ledger store.
   *  Steps (b)-(f) of FR-30 run inside one transaction guarded by
   *  `pg_advisory_xact_lock` on a fixed key so concurrent callers queue
   *  rather than race and fork the chain. */
  async append(input: LedgerAppendInput): Promise<LedgerEntry> {
    const start = Date.now();
    const client = await this.pool.connect();
    try {
      const entry = await this.appendWithinTransaction(client, input);
      logOperation({
        operation: "append",
        entityType: input.entity_ref.entity_type,
        entityId: input.entity_ref.entity_id,
        outcome: "success",
        durationMs: Date.now() - start,
        detail: { event_type: input.event_type, sequence_number: entry.sequence_number }
      });
      return entry;
    } catch (error) {
      logOperation({
        operation: "append",
        entityType: input.entity_ref.entity_type,
        entityId: input.entity_ref.entity_id,
        outcome: "error",
        durationMs: Date.now() - start
      });
      throw new LedgerAppendError(`appendLedgerEntry failed for event_type "${input.event_type}".`, { cause: error });
    } finally {
      client.release();
    }
  }

  private async appendWithinTransaction(client: PoolClient, input: LedgerAppendInput): Promise<LedgerEntry> {
    await client.query("BEGIN");
    try {
      // FR-31: serialize (b)-(f) so no two concurrent callers can read
      // the same "current last entry" and fork the chain.
      await client.query("SELECT pg_advisory_xact_lock($1)", [LEDGER_ADVISORY_LOCK_KEY]);

      const prevResult = await client.query<{ entry_hash: string; sequence_number: string | number }>(
        "SELECT entry_hash, sequence_number FROM audit_ledger ORDER BY sequence_number DESC LIMIT 1"
      );
      const prevEntryHash = prevResult.rows[0]?.entry_hash ?? GENESIS_HASH;
      const sequenceNumber = prevResult.rows[0] ? Number(prevResult.rows[0].sequence_number) + 1 : 1;

      // FR-30(d): timestamp is the ledger store's own clock, never a
      // caller-supplied value. Read as raw text (see driver.ts's
      // TIMESTAMPTZ type-parser override) so the exact string hashed
      // below is exactly the string a later read of this row returns.
      const nowResult = await client.query<{ now: string }>("SELECT now()::text AS now");
      const timestamp = nowResult.rows[0].now;

      const payloadHash = computePayloadHash(input.payload);
      const entryHash = computeEntryHash({
        sequence_number: sequenceNumber,
        timestamp,
        event_type: input.event_type,
        payload_hash: payloadHash,
        prev_entry_hash: prevEntryHash
      });

      const relatedObligationId = deriveRelatedObligationId(input);

      const insertResult = await client.query<AuditLedgerRow>(
        `INSERT INTO audit_ledger
           (sequence_number, timestamp, event_type, actor_type, actor_id, entity_type, entity_id,
            related_obligation_id, payload, payload_hash, prev_entry_hash, entry_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING sequence_number, timestamp, event_type, actor_type, actor_id, entity_type, entity_id,
                   related_obligation_id, payload, payload_hash, prev_entry_hash, entry_hash`,
        [
          sequenceNumber,
          timestamp,
          input.event_type,
          input.actor.type,
          input.actor.id,
          input.entity_ref.entity_type,
          input.entity_ref.entity_id,
          relatedObligationId,
          JSON.stringify(input.payload),
          payloadHash,
          prevEntryHash,
          entryHash
        ]
      );

      await client.query("COMMIT");
      return rowToLedgerEntry(insertResult.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  /** FR-38: filters by any combination of entityType+entityId,
   *  eventTypes, timestamp range, and sequence range; ordered by
   *  sequence_number ascending; capped at limit (default 100, hard max
   *  1000, NFR-6).
   *
   *  FR-39's join: when `entityType === "Obligation"`, the filter runs
   *  against the denormalized `related_obligation_id` column rather than
   *  the literal `entity_type`/`entity_id` columns, so an Obligation
   *  query transparently includes HumanReview/SLA entries that concern
   *  the obligation indirectly — see deriveRelatedObligationId's doc
   *  comment. Every other entityType filters on the literal columns
   *  (querying "all ledger entries about EvidenceArtifact X" means
   *  exactly that, not a joined story). This makes
   *  `queryLedger({ entityType: "Obligation", entityId, toTimestamp })`
   *  already equal to `getObligationAuditTrail`'s contract (agent file),
   *  which delegates straight through. */
  async query(q: LedgerQuery): Promise<LedgerEntry[]> {
    const start = Date.now();
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (q.entityType !== undefined && q.entityId !== undefined) {
      if (q.entityType === "Obligation") {
        params.push(q.entityId);
        clauses.push(`related_obligation_id = $${params.length}`);
      } else {
        params.push(q.entityType);
        clauses.push(`entity_type = $${params.length}`);
        params.push(q.entityId);
        clauses.push(`entity_id = $${params.length}`);
      }
    } else if (q.entityType !== undefined) {
      params.push(q.entityType);
      clauses.push(`entity_type = $${params.length}`);
    } else if (q.entityId !== undefined) {
      params.push(q.entityId);
      clauses.push(`entity_id = $${params.length}`);
    }

    if (q.eventTypes && q.eventTypes.length > 0) {
      params.push(q.eventTypes);
      clauses.push(`event_type = ANY($${params.length})`);
    }
    if (q.fromTimestamp) {
      params.push(q.fromTimestamp);
      clauses.push(`timestamp >= $${params.length}`);
    }
    if (q.toTimestamp) {
      params.push(q.toTimestamp);
      clauses.push(`timestamp <= $${params.length}`);
    }
    if (q.fromSequence !== undefined) {
      params.push(q.fromSequence);
      clauses.push(`sequence_number >= $${params.length}`);
    }
    if (q.toSequence !== undefined) {
      params.push(q.toSequence);
      clauses.push(`sequence_number <= $${params.length}`);
    }

    const limit = Math.min(q.limit ?? DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT);
    params.push(limit);

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const sql = `SELECT * FROM audit_ledger ${whereSql} ORDER BY sequence_number ASC LIMIT $${params.length}`;

    try {
      const result = await this.pool.query<AuditLedgerRow>(sql, params);
      const rows = result.rows.map(rowToLedgerEntry);
      logOperation({ operation: "query", outcome: "success", durationMs: Date.now() - start, detail: { rowCount: rows.length } });
      return rows;
    } catch (error) {
      logOperation({ operation: "query", outcome: "error", durationMs: Date.now() - start });
      throw error;
    }
  }

  async getLatestEntryForEntity(
    entityType: LedgerEntityRef["entity_type"],
    entityId: string,
    eventTypes: LedgerEventType[]
  ): Promise<LedgerEntry | null> {
    const start = Date.now();
    try {
      const result = await this.pool.query<AuditLedgerRow>(
        `SELECT * FROM audit_ledger
         WHERE entity_type = $1 AND entity_id = $2 AND event_type = ANY($3)
         ORDER BY sequence_number DESC LIMIT 1`,
        [entityType, entityId, eventTypes]
      );
      logOperation({ operation: "getLatestEntryForEntity", entityType, entityId, outcome: "success", durationMs: Date.now() - start });
      return result.rows[0] ? rowToLedgerEntry(result.rows[0]) : null;
    } catch (error) {
      logOperation({ operation: "getLatestEntryForEntity", entityType, entityId, outcome: "error", durationMs: Date.now() - start });
      throw error;
    }
  }

  /** FR-33–FR-36: walks the ledger in sequence_number order, paginated
   *  (NFR-2), stopping at the first break. A passing run appends its own
   *  CHAIN_VERIFICATION_RUN entry via this class's own `append()` (the
   *  sole ledger-store insert path, FR-29 — there is no separate
   *  "appendLedgerEntry" function inside this package; the agent-layer
   *  `appendLedgerEntry` in Spec 07's agent file is a thin delegate to
   *  `ctx.ledger.append`, and this method is that same ledger instance
   *  calling its own method directly). A failing run does NOT append to
   *  the (possibly-compromised) chain — it logs CRITICAL and writes a
   *  `ledger_verification_runs` row instead. */
  async verifyChainIntegrity(range?: { fromSequence?: number; toSequence?: number }): Promise<ChainVerificationResult> {
    const start = Date.now();
    const fromSequence = range?.fromSequence ?? 1;
    const toSequence = range?.toSequence;

    let expectedPrevHash: string;
    if (fromSequence <= 1) {
      expectedPrevHash = GENESIS_HASH;
    } else {
      const priorResult = await this.pool.query<{ entry_hash: string }>("SELECT entry_hash FROM audit_ledger WHERE sequence_number = $1", [
        fromSequence - 1
      ]);
      expectedPrevHash = priorResult.rows[0]?.entry_hash ?? GENESIS_HASH;
    }

    let cursor = fromSequence;
    let entriesChecked = 0;
    let intact = true;
    let firstBroken: number | null = null;
    let lastChecked = fromSequence - 1;

    for (;;) {
      if (toSequence !== undefined && cursor > toSequence) {
        break;
      }
      const upperBound = toSequence !== undefined ? Math.min(cursor + VERIFY_PAGE_SIZE - 1, toSequence) : cursor + VERIFY_PAGE_SIZE - 1;

      const page = await this.pool.query<AuditLedgerRow>(
        "SELECT * FROM audit_ledger WHERE sequence_number >= $1 AND sequence_number <= $2 ORDER BY sequence_number ASC",
        [cursor, upperBound]
      );
      if (page.rows.length === 0) {
        break;
      }

      for (const row of page.rows) {
        const entry = rowToLedgerEntry(row);
        entriesChecked += 1;
        lastChecked = entry.sequence_number;
        const check = checkEntryIntegrity(entry, expectedPrevHash);
        if (!check.ok) {
          intact = false;
          firstBroken = entry.sequence_number;
          break;
        }
        expectedPrevHash = entry.entry_hash;
      }

      if (!intact) {
        break;
      }
      if (page.rows.length < upperBound - cursor + 1) {
        // Reached the end of the table before filling the page.
        break;
      }
      cursor = upperBound + 1;
    }

    const result: ChainVerificationResult = {
      verifiedRangeStart: fromSequence,
      verifiedRangeEnd: lastChecked,
      entriesChecked,
      intact,
      firstBrokenSequenceNumber: firstBroken,
      ranAt: new Date().toISOString()
    };

    if (intact) {
      // FR-35: a passing run appends its own CHAIN_VERIFICATION_RUN
      // ledger entry.
      await this.append({
        event_type: "CHAIN_VERIFICATION_RUN",
        actor: { type: "system", id: "chain-verification-cron" },
        entity_ref: { entity_type: null, entity_id: null },
        payload: {
          verifiedRangeStart: result.verifiedRangeStart,
          verifiedRangeEnd: result.verifiedRangeEnd,
          entriesChecked: result.entriesChecked
        }
      });
      logOperation({ operation: "verifyChainIntegrity", outcome: "success", durationMs: Date.now() - start, detail: { ...result } });
    } else {
      // FR-36: CRITICAL log + a side-channel ledger_verification_runs
      // row, never a ledger append.
      logCritical("verifyChainIntegrity", { ...result });
      await this.recordVerificationRunFailure(result);
    }

    return result;
  }

  private async recordVerificationRunFailure(result: ChainVerificationResult): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO ledger_verification_runs
           (ran_at, verified_range_start, verified_range_end, entries_checked, intact, first_broken_sequence_number)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [result.ranAt, result.verifiedRangeStart, result.verifiedRangeEnd, result.entriesChecked, result.intact, result.firstBrokenSequenceNumber]
      );
    } catch (error) {
      // §8/FR-36: the side channel itself failing is the worst case —
      // CRITICAL-log it too rather than throwing (the CRITICAL log for
      // the original break has already been emitted above; this second
      // log makes the side-channel's own failure visible as well).
      logCritical("ledgerVerificationRunRecordFailed", { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
