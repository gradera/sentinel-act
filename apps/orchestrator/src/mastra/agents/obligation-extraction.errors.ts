// Typed error taxonomy for the Obligation Extraction Agent (Spec 03 §8,
// task 8). Mirrors packages/graph-db/src/errors.ts's convention exactly
// (extend Error, name = constructor name, preserve `cause`) so callers
// (the Orchestrator, tests) can branch on `instanceof` reliably instead of
// string-matching messages.

/** Base class for every error this agent throws directly (not counting
 *  errors it lets bubble up unchanged from @sentinel-act/graph-db, which
 *  already carry their own taxonomy). */
export class ObligationExtractionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** FR-4: the model's structured output failed Zod validation twice in a
 *  row (one retry already attempted with the validation error fed back
 *  into the prompt). Carries the raw model output and the Zod issues for
 *  debugging — never silently swallowed. */
export class ObligationExtractionValidationError extends ObligationExtractionError {
  constructor(
    message: string,
    public readonly issues?: unknown,
    public readonly rawOutput?: unknown,
    options?: { cause?: unknown }
  ) {
    super(message, options);
  }
}

/** §8: the LLM provider was unavailable or timed out on both the initial
 *  call and its single retry. This is an infra failure, distinct from a
 *  genuine informational-only clause (FR-6) — never coerced into
 *  `informational_only: true`. */
export class ObligationExtractionProviderError extends ObligationExtractionError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** §8: clause text failed a structural precondition this agent enforces
 *  before ever calling the model — either exceeding the safe context
 *  budget (>8,000 chars, possible upstream chunking bug) or some other
 *  malformed input shape. Distinct from the "too short" fast-path, which
 *  is not an error (FR-6 / §8 table — short clauses short-circuit to
 *  informational_only: true instead of throwing). */
export class ObligationExtractionInputError extends ObligationExtractionError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
