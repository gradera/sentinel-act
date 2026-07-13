// Error taxonomy for @sentinel-act/audit-ledger. Mirrors
// packages/graph-db/src/errors.ts's convention exactly: every write/read
// path in this package throws one of these (never a raw `pg` error, and
// never a bare Error) so callers can branch on `instanceof` reliably.

/** Base class for every error this package throws. Carries an optional
 *  `cause` chain (standard Error.cause) so the original driver error is
 *  never swallowed. */
export class AuditLedgerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The pool could not connect / a query failed with a transient
 *  connection-level error after Postgres was unreachable. */
export class AuditLedgerUnavailableError extends AuditLedgerError {}

/** A migration file's on-disk content no longer matches the checksum
 *  recorded for it in `schema_migrations` — refuses to silently re-apply
 *  or skip. */
export class AuditLedgerSchemaError extends AuditLedgerError {}

/** `append()` failed for any reason other than connectivity (a
 *  constraint violation, the advisory-lock transaction rolling back).
 *  Always carries the original error via `cause`. */
export class LedgerAppendError extends AuditLedgerError {}
