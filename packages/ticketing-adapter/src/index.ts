// Public API surface of @sentinel-act/ticketing-adapter (Spec 13). Every
// other package/app imports from here, mirroring
// packages/audit-ledger/src/index.ts's convention. Keep this file
// additive-only across specs.

// Domain types (§4).
export type {
  TicketPriority,
  TicketAssignee,
  CreateTicketRequest,
  CreateTicketResult,
  UpdateTicketFields,
  UpdateTicketRequest,
  UpdateTicketResult,
  TicketingAdapter,
  RoleAssigneeMapPort,
  ObligationCommittedEvent,
  OutboxStatus,
  TicketingOutboxEntry,
  TicketMapping,
  GraphQueryPort,
  AppendLedgerEntryPort,
  TicketingOutboxPort,
  TicketingContext,
  TicketLineage
} from "./types.js";
export { BUILD_TICKET_LINEAGE_CYPHER } from "./types.js";

// Error taxonomy.
export { TicketingAdapterError, TicketingUnavailableError, TicketingSchemaError, ValidationError, TicketResolutionError, AdapterCallError } from "./errors.js";

// Structured logging.
export { logOperation, logOutboxTransition } from "./logger.js";
export type { LogOperationInput, OutboxTransitionLogInput } from "./logger.js";

// Driver / connection management.
export { createPool, getPool, closePool, verifyConnectivity } from "./driver.js";
export type { TicketingDbConfig } from "./driver.js";

// Migrations.
export { runMigrations, DEFAULT_MIGRATIONS_DIR } from "./migrations/runner.js";
export type { MigrationRunResult } from "./migrations/runner.js";

// Pure mapping functions (FR-5..FR-12).
export {
  buildCreateTicketRequest,
  computeTicketDueDate,
  computeTicketPriority,
  computeBackoffDelayMs,
  composeDescription,
  composeLineageLine,
  composeLabels,
  resolveAssignee
} from "./mapping.js";

// RoleAssigneeMapPort default implementation (FR-9).
export { StaticRoleAssigneeMap, createStaticRoleAssigneeMap, DEFAULT_ROLE_ASSIGNEE_MAP_PATH } from "./role-assignee-map.js";
export type { RoleAssigneeMapConfig } from "./role-assignee-map.js";

// The Postgres-backed TicketingOutboxPort implementation.
export { PostgresTicketingOutboxPort } from "./postgres-ticketing-outbox.js";

// The generic outbound webhook reference adapter (FR-22..FR-24).
export { GenericWebhookAdapter, classifyHttpStatus } from "./adapters/generic-webhook.adapter.js";
export type { GenericWebhookAdapterConfig } from "./adapters/generic-webhook.adapter.js";

// Outbox worker + ops utility (FR-13..FR-18).
export { processOutboxOnce, resetOutboxEntry } from "./outbox-worker.js";
export type { ProcessOutboxResult } from "./outbox-worker.js";

// Shared test fixture (FR-10 drift guard) — exported so
// apps/orchestrator's Spec 07 computeTaskDeadline tests can assert
// against the exact same table as this package's computeTicketDueDate
// tests.
export { DEADLINE_FIXTURE } from "./__fixtures__/deadline.fixture.js";
export type { DeadlineFixtureCase } from "./__fixtures__/deadline.fixture.js";
