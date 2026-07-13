// Typed error taxonomy for the Monitoring and Audit Agent (Spec 07 §8).
// Mirrors mapping-risk-scoring.errors.ts's convention exactly (extend
// Error, name = constructor name, preserve `cause`) so callers (the
// Orchestrator, Spec 09/11's HTTP handlers, tests) can branch on
// `instanceof` reliably instead of string-matching messages.

export class MonitoringAuditError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Standard input validation failure (FR-18, FR-19, FR-20, FR-22,
 *  NFR-6's oversized-file case) — thrown before any graph or ledger
 *  write, HTTP 400/413 at the transport layer. */
export class ValidationError extends MonitoringAuditError {
  constructor(
    message: string,
    public readonly field: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
  }
}

/** FR-3's defensive invariant: this unit's graph-write capability MUST
 *  only ever be invoked with a CommitPlan whose `nodes` object has at
 *  most one of `humanReviews`/`evidenceArtifacts` populated (never both,
 *  never any other `nodes.*` key, never a `supersessions` entry). This
 *  error is thrown if that invariant is ever violated — a defect in this
 *  unit's own code, not a caller input problem. */
export class MonitoringAuditInvariantError extends MonitoringAuditError {}

/** FR-23: a reviewer's decision on a given obligation is final — a
 *  second, non-retry submission from the same reviewer_id for the same
 *  obligation is rejected with this distinct, HTTP-409-mappable error
 *  (also structurally prevents one person from being both maker and
 *  checker on the same Tier C item). */
export class SameReviewerNotAllowedError extends MonitoringAuditError {
  readonly code = "SAME_REVIEWER_NOT_ALLOWED" as const;
}

/** FR-23: the existing review count already meets or exceeds the tier's
 *  required count (1 for Tier B, 2 for Tier C) — the Orchestrator should
 *  already have transitioned this obligation off the review path. */
export class ReviewAlreadyCompleteError extends MonitoringAuditError {
  readonly code = "REVIEW_ALREADY_COMPLETE" as const;
}
