// Spec 07 §10: attempts a raw UPDATE/DELETE against the audit_ledger
// table using the application's DB role, asserts it is rejected by the
// trigger (FR-32). No Docker is available in the sandbox this unit was
// authored in — written for CI to run, see package.json's
// "test:integration" script.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { runMigrations } from "../../src/migrations/runner.js";
import { PostgresAuditLedger } from "../../src/postgres-audit-ledger.js";

describe("ledger append-only enforcement (FR-32)", () => {
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

  it("rejects a raw UPDATE against an existing row", async () => {
    const entry = await ledger.append({
      event_type: "SLA_BREACHED",
      actor: { type: "system", id: "sla-scan-cron" },
      entity_ref: { entity_type: "ProcessTask", entity_id: "task-1" },
      payload: {}
    });

    await expect(pool.query("UPDATE audit_ledger SET entry_hash = $1 WHERE sequence_number = $2", ["f".repeat(64), entry.sequence_number])).rejects.toThrow(
      /append-only/i
    );
  });

  it("rejects a raw DELETE against an existing row", async () => {
    const entry = await ledger.append({
      event_type: "SLA_BREACHED",
      actor: { type: "system", id: "sla-scan-cron" },
      entity_ref: { entity_type: "ProcessTask", entity_id: "task-2" },
      payload: {}
    });

    await expect(pool.query("DELETE FROM audit_ledger WHERE sequence_number = $1", [entry.sequence_number])).rejects.toThrow(/append-only/i);
  });
});
