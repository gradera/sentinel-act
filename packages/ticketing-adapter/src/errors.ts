// Error taxonomy for @sentinel-act/ticketing-adapter. Mirrors
// packages/audit-ledger/src/errors.ts's convention exactly: every
// write/read path in this package throws one of these (never a raw `pg`
// or `fetch` error, and never a bare Error) so callers can branch on
// `instanceof` reliably.

/** Base class for every error this package throws. Carries an optional
 *  `cause` chain (standard Error.cause) so the original driver/HTTP error
 *  is never swallowed. */
export class TicketingAdapterError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The Postgres pool could not connect / a query failed with a transient
 *  connection-level error after Postgres was unreachable. */
export class TicketingUnavailableError extends TicketingAdapterError {}

/** A migration file's on-disk content no longer matches the checksum
 *  recorded for it in `schema_migrations` — refuses to silently re-apply
 *  or skip. */
export class TicketingSchemaError extends TicketingAdapterError {}

/** FR-1: `ObligationCommittedEvent` intake validation failure — rejected
 *  before any outbox row is inserted. */
export class ValidationError extends TicketingAdapterError {
  constructor(
    message: string,
    public readonly field: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
  }
}

/** FR-5: the Obligation/ProcessTask this event references no longer
 *  resolves via the read-only Cypher lookup — treated as a permanent
 *  failure by the caller (append-only graph model, will never resolve on
 *  a later retry), not retried by this package itself. */
export class TicketResolutionError extends TicketingAdapterError {}

/** Thrown by GenericWebhookAdapter (and any other TicketingAdapter
 *  implementation) to carry the FR-22/FR-23 retryable-vs-permanent
 *  classification through to processOutboxOnce, so the outbox worker
 *  never needs adapter-specific knowledge (HTTP status codes, etc.) to
 *  decide FR-16 vs FR-17. */
export class AdapterCallError extends TicketingAdapterError {
  constructor(
    message: string,
    public readonly classification: "retryable" | "permanent",
    options?: { cause?: unknown }
  ) {
    super(message, options);
  }
}
