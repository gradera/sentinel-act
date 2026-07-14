// Postgres-backed TicketingOutboxPort implementation (§6.5's storage
// recommendation), against the schema in
// migrations/001_ticketing_outbox.sql. Every method wraps unexpected `pg`
// errors in TicketingUnavailableError so callers never see a raw driver
// error (same taxonomy discipline as packages/audit-ledger).
import type { Pool, QueryResultRow } from "pg";
import type { TicketingOutboxEntry, TicketingOutboxPort, TicketMapping } from "./types.js";
import { TicketingUnavailableError } from "./errors.js";

interface OutboxRow {
  id: string;
  event_id: string;
  obligation_id: string;
  task_id: string;
  tier: TicketingOutboxEntry["tier"];
  status: TicketingOutboxEntry["status"];
  attempts: number;
  next_attempt_at: Date | string;
  last_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface MappingRow {
  task_id: string;
  adapter_name: string;
  external_ticket_id: string;
  external_ticket_url: string | null;
  created_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rowToEntry(row: OutboxRow): TicketingOutboxEntry {
  return {
    id: row.id,
    event_id: row.event_id,
    obligation_id: row.obligation_id,
    task_id: row.task_id,
    tier: row.tier,
    status: row.status,
    attempts: row.attempts,
    next_attempt_at: toIso(row.next_attempt_at),
    last_error: row.last_error,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at)
  };
}

function rowToMapping(row: MappingRow): TicketMapping {
  return {
    task_id: row.task_id,
    adapter_name: row.adapter_name,
    external_ticket_id: row.external_ticket_id,
    external_ticket_url: row.external_ticket_url,
    created_at: toIso(row.created_at)
  };
}

async function runQuery<T extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  text: string,
  params: unknown[]
): Promise<{ rows: T[]; rowCount: number }> {
  try {
    const result = await pool.query<T>(text, params);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  } catch (error) {
    throw new TicketingUnavailableError("Postgres query failed for @sentinel-act/ticketing-adapter's outbox store.", { cause: error });
  }
}

export class PostgresTicketingOutboxPort implements TicketingOutboxPort {
  constructor(private readonly pool: Pool) {}

  async insertIfNotExists(
    entry: Omit<TicketingOutboxEntry, "status" | "attempts" | "next_attempt_at" | "last_error" | "created_at" | "updated_at">
  ): Promise<{ inserted: boolean }> {
    const { rowCount } = await runQuery(
      this.pool,
      `INSERT INTO ticketing_outbox (id, event_id, obligation_id, task_id, tier)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING id`,
      [entry.id, entry.event_id, entry.obligation_id, entry.task_id, entry.tier]
    );
    return { inserted: rowCount > 0 };
  }

  /** FR-13/FR-14: select up to `limit` claimable candidates (status IN
   *  ('pending','failed_retryable') AND next_attempt_at <= now, ordered by
   *  created_at ascending), then compare-and-set claim each one
   *  individually — a candidate already claimed by a concurrent worker
   *  instance (0 rows affected) is skipped, matching FR-14's literal
   *  per-row CAS wording (as opposed to a single batch UPDATE ... WHERE id
   *  IN (subquery), which would be equally race-safe but not match the
   *  spec's described per-row skip-and-continue behavior as directly). */
  async claimBatch(limit: number, now: string): Promise<TicketingOutboxEntry[]> {
    const { rows: candidates } = await runQuery<{ id: string }>(
      this.pool,
      `SELECT id FROM ticketing_outbox
       WHERE status IN ('pending', 'failed_retryable') AND next_attempt_at <= $1
       ORDER BY created_at ASC
       LIMIT $2`,
      [now, limit]
    );

    const claimed: TicketingOutboxEntry[] = [];
    for (const candidate of candidates) {
      const { rows } = await runQuery<OutboxRow>(
        this.pool,
        `UPDATE ticketing_outbox
         SET status = 'processing'
         WHERE id = $1 AND status IN ('pending', 'failed_retryable')
         RETURNING *`,
        [candidate.id]
      );
      if (rows.length > 0) {
        claimed.push(rowToEntry(rows[0]));
      }
      // rows.length === 0: a concurrent worker already claimed this row —
      // skip it and move to the next candidate (FR-14).
    }
    return claimed;
  }

  async markSucceeded(id: string): Promise<void> {
    await runQuery(this.pool, `UPDATE ticketing_outbox SET status = 'succeeded' WHERE id = $1`, [id]);
  }

  async markRetryable(id: string, nextAttemptAt: string, error: string): Promise<void> {
    await runQuery(
      this.pool,
      `UPDATE ticketing_outbox
       SET status = 'failed_retryable', attempts = attempts + 1, next_attempt_at = $2, last_error = $3
       WHERE id = $1`,
      [id, nextAttemptAt, error]
    );
  }

  async markPermanentFailure(id: string, error: string): Promise<void> {
    await runQuery(
      this.pool,
      `UPDATE ticketing_outbox
       SET status = 'failed_permanent', attempts = attempts + 1, last_error = $2
       WHERE id = $1`,
      [id, error]
    );
  }

  async resetToPending(id: string): Promise<void> {
    await runQuery(
      this.pool,
      `UPDATE ticketing_outbox
       SET status = 'pending', attempts = 0, last_error = NULL, next_attempt_at = now()
       WHERE id = $1`,
      [id]
    );
  }

  async findMapping(task_id: string): Promise<TicketMapping | null> {
    const { rows } = await runQuery<MappingRow>(this.pool, `SELECT * FROM ticket_mapping WHERE task_id = $1`, [task_id]);
    return rows.length > 0 ? rowToMapping(rows[0]) : null;
  }

  async insertMapping(mapping: TicketMapping): Promise<{ inserted: boolean }> {
    const { rowCount } = await runQuery(
      this.pool,
      `INSERT INTO ticket_mapping (task_id, adapter_name, external_ticket_id, external_ticket_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (task_id) DO NOTHING
       RETURNING task_id`,
      [mapping.task_id, mapping.adapter_name, mapping.external_ticket_id, mapping.external_ticket_url]
    );
    return { inserted: rowCount > 0 };
  }

  async hasInFlightEntryForTask(task_id: string): Promise<boolean> {
    const { rows } = await runQuery(
      this.pool,
      `SELECT 1 FROM ticketing_outbox WHERE task_id = $1 AND status IN ('pending', 'processing', 'failed_retryable') LIMIT 1`,
      [task_id]
    );
    return rows.length > 0;
  }
}
