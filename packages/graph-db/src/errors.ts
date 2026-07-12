// Error taxonomy for @sentinel-act/graph-db. Every write/read path in
// this package throws one of these (never a raw neo4j-driver error, and
// never a bare Error) so callers (the Orchestrator, agents, seed CLI)
// can branch on `instanceof` reliably. See spec §8 for the mapping from
// failure mode to error type.

/** Base class for every error this package throws. Carries an optional
 *  `cause` chain (standard Error.cause) so the original driver/zod error
 *  is never swallowed. */
export class GraphDbError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A `supersede` call's guarded MATCH (`WHERE old.valid_to IS NULL`)
 *  matched zero rows: either the id doesn't exist at all, or it was
 *  already superseded (by this call or a concurrent winner). FR-10,
 *  FR-14. */
export class ConflictError extends GraphDbError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** Input failed zod (CommitPlan) or per-field repository validation
 *  before any Cypher ran. FR-13. */
export class ValidationError extends GraphDbError {
  constructor(
    message: string,
    public readonly issues?: unknown,
    options?: { cause?: unknown }
  ) {
    super(message, options);
  }
}

/** `findById`/`findAsOf` found nothing for a required lookup where the
 *  caller asked for "must exist" semantics (repositories' plain
 *  `findById`/`findAsOf` return null instead; this is for helpers that
 *  need to fail loudly, e.g. commit-plan edge-endpoint resolution). */
export class NotFoundError extends GraphDbError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** `GraphWriter.commitProposal` failed for any reason other than
 *  validation (Cypher error, timeout, a wrapped ConflictError from a
 *  supersession inside the plan). Always carries the original error via
 *  `cause`. FR-12. */
export class CommitError extends GraphDbError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** The driver could not connect / a query failed with a transient
 *  driver-level error (ServiceUnavailable, SessionExpired) after the
 *  driver's own retry policy was exhausted. */
export class GraphDbUnavailableError extends GraphDbError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** A required schema object (constraint, index, the vector index) is
 *  missing or misconfigured. Treated as a deployment bug, not a runtime
 *  data condition — never silently degraded. FR-20. */
export class GraphDbSchemaError extends GraphDbError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
