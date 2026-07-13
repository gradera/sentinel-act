// Spec 07 §10: fires N concurrent appendLedgerEntry calls against a real
// Postgres (testcontainers), asserts the resulting chain has no
// duplicate sequence_number, no fork (every prev_entry_hash matches
// exactly one prior entry_hash), and verifyChainIntegrity reports
// intact: true afterward (FR-31). No Docker is available in the sandbox
// this unit was authored in, so this suite is written for CI to run —
// see package.json's "test:integration" script.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { runMigrations } from "../../src/migrations/runner.js";
import { PostgresAuditLedger } from "../../src/postgres-audit-ledger.js";
import type { LedgerAppendInput } from "../../src/types.js";

describe("ledger append concurrency (FR-31)", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let ledger: PostgresAuditLedger;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await runMigrations(pool);
    ledger = new PostgresAuditLedger(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  }, 60_000);

  it("N concurrent appends produce a gapless, unforked chain", async () => {
    const CONCURRENCY = 25;
    const inputs: LedgerAppendInput[] = Array.from({ length: CONCURRENCY }, (_, i) => ({
      event_type: "SLA_BREACHED",
      actor: { type: "system", id: "sla-scan-cron" },
      entity_ref: { entity_type: "ProcessTask", entity_id: `task-${i}` },
      payload: { i }
    }));

    const entries = await Promise.all(inputs.map((input) => ledger.append(input)));

    const sequenceNumbers = entries.map((e) => e.sequence_number).sort((a, b) => a - b);
    const uniqueSequenceNumbers = new Set(sequenceNumbers);
    expect(uniqueSequenceNumbers.size).toBe(CONCURRENCY);
    expect(sequenceNumbers).toEqual(Array.from({ length: CONCURRENCY }, (_, i) => i + 1));

    const entryHashBySequence = new Map(entries.map((e) => [e.sequence_number, e.entry_hash]));
    for (const entry of entries) {
      if (entry.sequence_number === 1) continue;
      const expectedPrevHash = entryHashBySequence.get(entry.sequence_number - 1);
      expect(entry.prev_entry_hash).toBe(expectedPrevHash);
    }

    const result = await ledger.verifyChainIntegrity();
    expect(result.intact).toBe(true);
  });
});
