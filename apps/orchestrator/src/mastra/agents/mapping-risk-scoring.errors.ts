// Typed error taxonomy for the Mapping and Risk Scoring Agent (Spec 05 §8).
// Mirrors obligation-extraction.errors.ts / packages/graph-db/src/errors.ts's
// convention exactly (extend Error, name = constructor name, preserve
// `cause`) so callers (the Orchestrator, tests) can branch on `instanceof`
// reliably instead of string-matching messages.

export class MappingRiskScoringError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** §8: an Obligation was handed to this unit missing a required field
 *  entirely (e.g. `category` is `undefined`, not just an empty string) —
 *  should not happen post-Spec-03 validation, but this unit must not
 *  assume it. The Orchestrator catches this, does not commit anything, and
 *  logs the failure to the audit trail as a pipeline defect (distinct from
 *  a business-as-usual low-confidence mapping). */
export class MappingValidationError extends MappingRiskScoringError {
  constructor(
    message: string,
    public readonly field: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
  }
}
