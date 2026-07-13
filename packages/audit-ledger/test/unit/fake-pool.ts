// A minimal in-memory fake of the `pg` Pool/PoolClient surface
// PostgresAuditLedger actually calls, so append()/verifyChainIntegrity()
// can be exercised end to end (real sequencing/hash-chaining logic)
// without a live Postgres instance. Matches on the literal SQL text
// PostgresAuditLedger sends — brittle by nature (same trade-off the
// mapping-risk-scoring tests make with their fakeGraph* helpers matching
// on Cypher substrings), acceptable for a unit-test double.
import { vi } from "vitest";

export interface FakeRow {
  sequence_number: number;
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

export interface FakePool {
  readonly rows: FakeRow[];
  readonly verificationRuns: unknown[][];
  readonly nextTimestamps: string[];
  readonly advisoryLockCalls: { count: number };
  connect: () => Promise<{ query: FakePool["query"]; release: () => void }>;
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}

let timestampCounter = 0;

function defaultNextTimestamp(): string {
  timestampCounter += 1;
  const seconds = String(timestampCounter).padStart(2, "0");
  return `2026-07-13 00:00:${seconds}.000000+00`;
}

export function createFakePool(seed: FakeRow[] = []): FakePool {
  const state = {
    rows: [...seed] as FakeRow[],
    verificationRuns: [] as unknown[][],
    nextTimestamps: [] as string[],
    advisoryLockCalls: { count: 0 }
  };

  async function handleQuery(text: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
    const sql = text.trim();

    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [] };
    }

    if (sql.startsWith("SELECT pg_advisory_xact_lock")) {
      state.advisoryLockCalls.count += 1;
      return { rows: [] };
    }

    if (sql.includes("SELECT entry_hash, sequence_number FROM audit_ledger ORDER BY sequence_number DESC LIMIT 1")) {
      const last = state.rows[state.rows.length - 1];
      return { rows: last ? [{ entry_hash: last.entry_hash, sequence_number: last.sequence_number }] : [] };
    }

    if (sql.includes("SELECT now()::text AS now")) {
      const ts = state.nextTimestamps.shift() ?? defaultNextTimestamp();
      return { rows: [{ now: ts }] };
    }

    if (sql.startsWith("INSERT INTO audit_ledger")) {
      const [
        sequence_number,
        timestamp,
        event_type,
        actor_type,
        actor_id,
        entity_type,
        entity_id,
        related_obligation_id,
        payloadJson,
        payload_hash,
        prev_entry_hash,
        entry_hash
      ] = params as [number, string, string, string, string, string | null, string | null, string | null, string, string, string, string];
      const row: FakeRow = {
        sequence_number,
        timestamp,
        event_type,
        actor_type,
        actor_id,
        entity_type,
        entity_id,
        related_obligation_id,
        payload: JSON.parse(payloadJson) as Record<string, unknown>,
        payload_hash,
        prev_entry_hash,
        entry_hash
      };
      state.rows.push(row);
      return { rows: [row] };
    }

    if (sql.includes("SELECT entry_hash FROM audit_ledger WHERE sequence_number = $1")) {
      const seq = params[0] as number;
      const row = state.rows.find((r) => r.sequence_number === seq);
      return { rows: row ? [{ entry_hash: row.entry_hash }] : [] };
    }

    if (sql.includes("WHERE sequence_number >= $1 AND sequence_number <= $2")) {
      const [from, to] = params as [number, number];
      const page = state.rows
        .filter((r) => r.sequence_number >= from && r.sequence_number <= to)
        .sort((a, b) => a.sequence_number - b.sequence_number);
      return { rows: page };
    }

    if (sql.includes("WHERE entity_type = $1 AND entity_id = $2 AND event_type = ANY($3)")) {
      const [entityType, entityId, eventTypes] = params as [string, string, string[]];
      const matches = state.rows
        .filter((r) => r.entity_type === entityType && r.entity_id === entityId && eventTypes.includes(r.event_type))
        .sort((a, b) => b.sequence_number - a.sequence_number);
      return { rows: matches.slice(0, 1) };
    }

    if (sql.startsWith("INSERT INTO ledger_verification_runs")) {
      state.verificationRuns.push(params);
      return { rows: [] };
    }

    // Generic `query()` dynamic SELECT — this fake doesn't implement a
    // real WHERE-clause evaluator; PostgresAuditLedger.query()'s SQL
    // shape (which clauses/params it builds) is tested separately via a
    // spy on pool.query, not through this fake's row-filtering.
    if (sql.startsWith("SELECT * FROM audit_ledger")) {
      return { rows: [...state.rows].sort((a, b) => a.sequence_number - b.sequence_number) };
    }

    throw new Error(`FakePool: unhandled query: ${sql}`);
  }

  return {
    rows: state.rows,
    verificationRuns: state.verificationRuns,
    nextTimestamps: state.nextTimestamps,
    advisoryLockCalls: state.advisoryLockCalls,
    connect: vi.fn(async () => ({
      query: handleQuery,
      release: vi.fn()
    })),
    query: vi.fn(handleQuery)
  };
}
