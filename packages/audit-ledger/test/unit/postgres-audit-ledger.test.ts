// Unit tests for PostgresAuditLedger against the fake pool (test/unit/
// fake-pool.ts) — no live Postgres required. Covers §10's ledger test
// plan items: append() genesis/chaining/determinism (FR-30/FR-31),
// query()'s SQL shape per filter combo (FR-38/FR-39), getLatestEntryForEntity,
// and verifyChainIntegrity's pass/fail paths (FR-33–FR-36).
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { PostgresAuditLedger, checkEntryIntegrity } from "../../src/postgres-audit-ledger.js";
import { GENESIS_HASH } from "../../src/types.js";
import { computeEntryHash, computePayloadHash } from "../../src/canonicalize.js";
import { createFakePool, type FakeRow } from "./fake-pool.js";

function ledgerFrom(pool: ReturnType<typeof createFakePool>): PostgresAuditLedger {
  return new PostgresAuditLedger(pool as unknown as Pool);
}

// ---------------------------------------------------------------------------
// append (FR-29–FR-31)
// ---------------------------------------------------------------------------

describe("PostgresAuditLedger.append", () => {
  it("FR-30: the first entry chains from GENESIS_HASH", async () => {
    const pool = createFakePool();
    const ledger = ledgerFrom(pool);

    const entry = await ledger.append({
      event_type: "SLA_BREACHED",
      actor: { type: "system", id: "sla-scan-cron" },
      entity_ref: { entity_type: "ProcessTask", entity_id: "task-1" },
      payload: { task_id: "task-1", obligation_id: "ob-1" }
    });

    expect(entry.sequence_number).toBe(1);
    expect(entry.prev_entry_hash).toBe(GENESIS_HASH);
    expect(entry.entry_hash).toHaveLength(64);
  });

  it("FR-30/FR-31: the second entry's prev_entry_hash equals the first entry's entry_hash", async () => {
    const pool = createFakePool();
    const ledger = ledgerFrom(pool);

    const first = await ledger.append({
      event_type: "SLA_BREACHED",
      actor: { type: "system", id: "sla-scan-cron" },
      entity_ref: { entity_type: "ProcessTask", entity_id: "task-1" },
      payload: { task_id: "task-1" }
    });
    const second = await ledger.append({
      event_type: "SLA_APPROACHING",
      actor: { type: "system", id: "sla-scan-cron" },
      entity_ref: { entity_type: "ProcessTask", entity_id: "task-2" },
      payload: { task_id: "task-2" }
    });

    expect(second.sequence_number).toBe(2);
    expect(second.prev_entry_hash).toBe(first.entry_hash);
  });

  it("FR-31: append acquires the advisory lock exactly once per call", async () => {
    const pool = createFakePool();
    const ledger = ledgerFrom(pool);
    await ledger.append({
      event_type: "SLA_BREACHED",
      actor: { type: "system", id: "sla-scan-cron" },
      entity_ref: { entity_type: "ProcessTask", entity_id: "task-1" },
      payload: {}
    });
    expect(pool.advisoryLockCalls.count).toBe(1);
  });

  it("FR-30: payload_hash/entry_hash recompute identically given the same canonicalized payload (determinism)", async () => {
    const pool = createFakePool();
    pool.nextTimestamps.push("2026-07-13 00:00:00.000000+00");
    const ledger = ledgerFrom(pool);

    const payload = { b: 1, a: { z: 1, y: 2 } };
    const entry = await ledger.append({
      event_type: "HUMAN_REVIEW_SUBMITTED",
      actor: { type: "human", id: "reviewer-a" },
      entity_ref: { entity_type: "HumanReview", entity_id: "review-1" },
      payload
    });

    expect(entry.payload_hash).toBe(computePayloadHash(payload));
    expect(entry.entry_hash).toBe(
      computeEntryHash({
        sequence_number: entry.sequence_number,
        timestamp: entry.timestamp,
        event_type: entry.event_type,
        payload_hash: entry.payload_hash,
        prev_entry_hash: entry.prev_entry_hash
      })
    );
  });

  it("FR-39: derives related_obligation_id from entity_ref when entity_type is Obligation", async () => {
    const pool = createFakePool();
    const ledger = ledgerFrom(pool);
    await ledger.append({
      event_type: "TIER_ROUTING_DECISION",
      actor: { type: "agent", id: "mapping-and-risk-scoring" },
      entity_ref: { entity_type: "Obligation", entity_id: "ob-1" },
      payload: {}
    });
    expect(pool.rows[0].related_obligation_id).toBe("ob-1");
  });

  it("FR-39: derives related_obligation_id from payload.obligation_id when entity_ref points elsewhere (e.g. HumanReview)", async () => {
    const pool = createFakePool();
    const ledger = ledgerFrom(pool);
    await ledger.append({
      event_type: "HUMAN_REVIEW_SUBMITTED",
      actor: { type: "human", id: "reviewer-a" },
      entity_ref: { entity_type: "HumanReview", entity_id: "review-1" },
      payload: { obligation_id: "ob-2" }
    });
    expect(pool.rows[0].related_obligation_id).toBe("ob-2");
  });

  it("leaves related_obligation_id null when neither entity_ref nor payload identify an obligation", async () => {
    const pool = createFakePool();
    const ledger = ledgerFrom(pool);
    await ledger.append({
      event_type: "EVIDENCE_ARTIFACT_INGESTED",
      actor: { type: "agent", id: "monitoring-and-audit" },
      entity_ref: { entity_type: "EvidenceArtifact", entity_id: "evidence-1" },
      payload: { task_id: "task-1" }
    });
    expect(pool.rows[0].related_obligation_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// query (FR-38/FR-39)
// ---------------------------------------------------------------------------

describe("PostgresAuditLedger.query", () => {
  it("filters on related_obligation_id when entityType is Obligation", async () => {
    const pool = createFakePool();
    const ledger = ledgerFrom(pool);
    await ledger.query({ entityType: "Obligation", entityId: "ob-1" });
    const [sql, params] = (pool.query as unknown as { mock: { calls: [string, unknown[]][] } }).mock.calls.at(-1)!;
    expect(sql).toContain("related_obligation_id = $1");
    expect(params[0]).toBe("ob-1");
  });

  it("filters on literal entity_type/entity_id columns for non-Obligation entityType", async () => {
    const pool = createFakePool();
    const ledger = ledgerFrom(pool);
    await ledger.query({ entityType: "EvidenceArtifact", entityId: "evidence-1" });
    const [sql, params] = (pool.query as unknown as { mock: { calls: [string, unknown[]][] } }).mock.calls.at(-1)!;
    expect(sql).toContain("entity_type = $1");
    expect(sql).toContain("entity_id = $2");
    expect(params[0]).toBe("EvidenceArtifact");
    expect(params[1]).toBe("evidence-1");
  });

  it("adds eventTypes / timestamp range / sequence range clauses when present", async () => {
    const pool = createFakePool();
    const ledger = ledgerFrom(pool);
    await ledger.query({
      eventTypes: ["HUMAN_REVIEW_SUBMITTED", "EVIDENCE_ARTIFACT_INGESTED"],
      fromTimestamp: "2026-07-01T00:00:00Z",
      toTimestamp: "2026-07-31T00:00:00Z",
      fromSequence: 5,
      toSequence: 50
    });
    const [sql] = (pool.query as unknown as { mock: { calls: [string, unknown[]][] } }).mock.calls.at(-1)!;
    expect(sql).toContain("event_type = ANY(");
    expect(sql).toContain("timestamp >= $");
    expect(sql).toContain("timestamp <= $");
    expect(sql).toContain("sequence_number >= $");
    expect(sql).toContain("sequence_number <= $");
    expect(sql).toContain("ORDER BY sequence_number ASC");
  });

  it("NFR-6: defaults limit to 100 and hard-caps at 1000 regardless of what is requested", async () => {
    const pool = createFakePool();
    const ledger = ledgerFrom(pool);

    await ledger.query({});
    let [, params] = (pool.query as unknown as { mock: { calls: [string, unknown[]][] } }).mock.calls.at(-1)!;
    expect(params.at(-1)).toBe(100);

    await ledger.query({ limit: 5000 });
    [, params] = (pool.query as unknown as { mock: { calls: [string, unknown[]][] } }).mock.calls.at(-1)!;
    expect(params.at(-1)).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// getLatestEntryForEntity (FR-9)
// ---------------------------------------------------------------------------

describe("PostgresAuditLedger.getLatestEntryForEntity", () => {
  it("returns null when there is no matching entry", async () => {
    const pool = createFakePool();
    const ledger = ledgerFrom(pool);
    const result = await ledger.getLatestEntryForEntity("ProcessTask", "task-1", ["SLA_APPROACHING", "SLA_BREACHED"]);
    expect(result).toBeNull();
  });

  it("returns the highest sequence_number match when multiple exist", async () => {
    const pool = createFakePool();
    const ledger = ledgerFrom(pool);
    await ledger.append({
      event_type: "SLA_APPROACHING",
      actor: { type: "system", id: "sla-scan-cron" },
      entity_ref: { entity_type: "ProcessTask", entity_id: "task-1" },
      payload: {}
    });
    await ledger.append({
      event_type: "SLA_BREACHED",
      actor: { type: "system", id: "sla-scan-cron" },
      entity_ref: { entity_type: "ProcessTask", entity_id: "task-1" },
      payload: {}
    });
    const result = await ledger.getLatestEntryForEntity("ProcessTask", "task-1", ["SLA_APPROACHING", "SLA_BREACHED"]);
    expect(result?.event_type).toBe("SLA_BREACHED");
    expect(result?.sequence_number).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// checkEntryIntegrity (FR-33) — pure per-row check
// ---------------------------------------------------------------------------

describe("checkEntryIntegrity", () => {
  function makeEntry(overrides: Partial<Parameters<typeof checkEntryIntegrity>[0]> = {}) {
    const payload = { a: 1 };
    const payloadHash = computePayloadHash(payload);
    const entryHash = computeEntryHash({
      sequence_number: 1,
      timestamp: "2026-07-13T00:00:00.000Z",
      event_type: "SLA_BREACHED",
      payload_hash: payloadHash,
      prev_entry_hash: GENESIS_HASH
    });
    return {
      sequence_number: 1,
      timestamp: "2026-07-13T00:00:00.000Z",
      event_type: "SLA_BREACHED" as const,
      actor: { type: "system" as const, id: "sla-scan-cron" },
      entity_ref: { entity_type: "ProcessTask" as const, entity_id: "task-1" },
      payload,
      payload_hash: payloadHash,
      prev_entry_hash: GENESIS_HASH,
      entry_hash: entryHash,
      ...overrides
    };
  }

  it("passes an intact entry", () => {
    const entry = makeEntry();
    expect(checkEntryIntegrity(entry, GENESIS_HASH)).toEqual({ ok: true });
  });

  it("detects a corrupted payload_hash", () => {
    const entry = makeEntry({ payload_hash: "f".repeat(64) });
    expect(checkEntryIntegrity(entry, GENESIS_HASH)).toEqual({ ok: false, reason: "payload_hash_mismatch" });
  });

  it("detects a corrupted entry_hash", () => {
    const entry = makeEntry({ entry_hash: "f".repeat(64) });
    expect(checkEntryIntegrity(entry, GENESIS_HASH)).toEqual({ ok: false, reason: "entry_hash_mismatch" });
  });

  it("detects a corrupted prev_entry_hash (breaks the chain link, not this row's own hash)", () => {
    // prev_entry_hash corrupted but entry_hash was computed over the
    // *original* prev_entry_hash — i.e. the stored entry_hash no longer
    // matches what would be recomputed from the (now-wrong) stored
    // prev_entry_hash, exactly like a real tamper scenario.
    const entry = makeEntry();
    const tampered = { ...entry, prev_entry_hash: "e".repeat(64) };
    // entry_hash recompute now also fails first (since entry_hash embeds
    // prev_entry_hash) — that's expected: any prev_entry_hash tamper is
    // caught by the entry_hash check before the explicit chain-link
    // check runs. Confirm the explicit chain-link check independently by
    // corrupting prev_entry_hash *without* the entry embedding it (a
    // scenario where an attacker fixed up entry_hash to match a forged
    // prev_entry_hash but not the true predecessor).
    expect(checkEntryIntegrity(tampered, GENESIS_HASH).ok).toBe(false);

    const forged = makeEntry({
      prev_entry_hash: "e".repeat(64),
      entry_hash: computeEntryHash({
        sequence_number: 1,
        timestamp: "2026-07-13T00:00:00.000Z",
        event_type: "SLA_BREACHED",
        payload_hash: computePayloadHash({ a: 1 }),
        prev_entry_hash: "e".repeat(64)
      })
    });
    expect(checkEntryIntegrity(forged, GENESIS_HASH)).toEqual({ ok: false, reason: "prev_entry_hash_mismatch" });
  });
});

// ---------------------------------------------------------------------------
// verifyChainIntegrity (FR-33–FR-36)
// ---------------------------------------------------------------------------

function buildIntactChain(length: number): FakeRow[] {
  const rows: FakeRow[] = [];
  let prevHash = GENESIS_HASH;
  for (let i = 1; i <= length; i += 1) {
    const timestamp = `2026-07-13 00:00:${String(i).padStart(2, "0")}.000000+00`;
    const payload = { i };
    const payloadHash = computePayloadHash(payload);
    const entryHash = computeEntryHash({
      sequence_number: i,
      timestamp,
      event_type: "SLA_BREACHED",
      payload_hash: payloadHash,
      prev_entry_hash: prevHash
    });
    rows.push({
      sequence_number: i,
      timestamp,
      event_type: "SLA_BREACHED",
      actor_type: "system",
      actor_id: "sla-scan-cron",
      entity_type: "ProcessTask",
      entity_id: `task-${i}`,
      related_obligation_id: null,
      payload,
      payload_hash: payloadHash,
      prev_entry_hash: prevHash,
      entry_hash: entryHash
    });
    prevHash = entryHash;
  }
  return rows;
}

describe("PostgresAuditLedger.verifyChainIntegrity", () => {
  it("FR-33/FR-35: an intact chain reports intact: true and appends a CHAIN_VERIFICATION_RUN entry", async () => {
    const rows = buildIntactChain(10);
    const pool = createFakePool(rows);
    const ledger = ledgerFrom(pool);

    const result = await ledger.verifyChainIntegrity();

    expect(result.intact).toBe(true);
    expect(result.entriesChecked).toBe(10);
    expect(result.firstBrokenSequenceNumber).toBeNull();
    const appended = pool.rows.find((r) => r.event_type === "CHAIN_VERIFICATION_RUN");
    expect(appended).toBeDefined();
    expect(pool.verificationRuns).toHaveLength(0);
  });

  it("FR-33/FR-34: a corrupted entry_hash is caught at the correct sequence_number, scan stops there", async () => {
    const rows = buildIntactChain(10);
    rows[4].entry_hash = "f".repeat(64); // sequence_number 5
    const pool = createFakePool(rows);
    const ledger = ledgerFrom(pool);

    const result = await ledger.verifyChainIntegrity();

    expect(result.intact).toBe(false);
    expect(result.firstBrokenSequenceNumber).toBe(5);
    // Not an earlier or later sequence number.
    expect(result.entriesChecked).toBe(5);
  });

  it("FR-33: a corrupted payload_hash is independently detected", async () => {
    const rows = buildIntactChain(5);
    rows[2].payload_hash = "a".repeat(64); // sequence_number 3
    const pool = createFakePool(rows);
    const ledger = ledgerFrom(pool);

    const result = await ledger.verifyChainIntegrity();

    expect(result.intact).toBe(false);
    expect(result.firstBrokenSequenceNumber).toBe(3);
  });

  it("FR-33: a corrupted prev_entry_hash (with entry_hash forged to match) is independently detected", async () => {
    const rows = buildIntactChain(5);
    const forgedPrev = "d".repeat(64);
    rows[2] = {
      ...rows[2],
      prev_entry_hash: forgedPrev,
      entry_hash: computeEntryHash({
        sequence_number: rows[2].sequence_number,
        timestamp: rows[2].timestamp,
        event_type: rows[2].event_type,
        payload_hash: rows[2].payload_hash,
        prev_entry_hash: forgedPrev
      })
    };
    const pool = createFakePool(rows);
    const ledger = ledgerFrom(pool);

    const result = await ledger.verifyChainIntegrity();

    expect(result.intact).toBe(false);
    expect(result.firstBrokenSequenceNumber).toBe(3);
  });

  it("FR-36: a failing run does not append a CHAIN_VERIFICATION_RUN ledger entry, and writes a ledger_verification_runs row", async () => {
    const rows = buildIntactChain(5);
    rows[1].entry_hash = "b".repeat(64);
    const pool = createFakePool(rows);
    const ledger = ledgerFrom(pool);

    await ledger.verifyChainIntegrity();

    expect(pool.rows.some((r) => r.event_type === "CHAIN_VERIFICATION_RUN")).toBe(false);
    expect(pool.verificationRuns).toHaveLength(1);
  });
});
