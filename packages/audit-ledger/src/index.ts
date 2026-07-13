// Public API surface of @sentinel-act/audit-ledger (Spec 07 §6.5). Every
// other package/app imports from here, mirroring
// packages/graph-db/src/index.ts's convention. Keep this file
// additive-only across specs.

// Domain types (§4).
export type {
  LedgerEventType,
  LedgerActor,
  LedgerEntityRef,
  LedgerEntry,
  LedgerAppendInput,
  LedgerQuery,
  ChainVerificationResult,
  AuditLedgerPort
} from "./types.js";
export { GENESIS_HASH } from "./types.js";

// Error taxonomy.
export { AuditLedgerError, AuditLedgerUnavailableError, AuditLedgerSchemaError, LedgerAppendError } from "./errors.js";

// Structured logging.
export { logOperation, logCritical } from "./logger.js";
export type { LogOperationInput } from "./logger.js";

// Canonical JSON / hashing helpers (exported so the orchestrator's
// reconciliation sweep, Task 12, can compute a matching payload_hash for
// a backfilled entry without duplicating this logic).
export { canonicalize, sha256Hex, computePayloadHash, computeEntryHash } from "./canonicalize.js";

// Driver / connection management.
export { createPool, getPool, closePool, verifyConnectivity } from "./driver.js";
export type { AuditLedgerDbConfig } from "./driver.js";

// Migrations.
export { runMigrations, DEFAULT_MIGRATIONS_DIR } from "./migrations/runner.js";
export type { MigrationRunResult } from "./migrations/runner.js";

// The Postgres-backed AuditLedgerPort implementation (§6.5's storage
// recommendation) — also exports `checkEntryIntegrity`, the pure
// per-row check `verifyChainIntegrity` is built from, so it is directly
// unit-testable.
export { PostgresAuditLedger, checkEntryIntegrity } from "./postgres-audit-ledger.js";
export type { EntryIntegrityCheck } from "./postgres-audit-ledger.js";
