// Typed error taxonomy for the Grounding and Verification Agent (Spec 04
// §8). Mirrors obligation-extraction.errors.ts's convention exactly
// (extend Error, name = constructor name, preserve `cause`) so callers
// (the Orchestrator, tests) can branch on `instanceof` reliably instead of
// string-matching messages.

/** Base class for every error this agent throws directly. */
export class GroundingVerificationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** §8 "Malformed model output": the model's structured output failed
 *  schema validation twice in a row (one retry already attempted with the
 *  validation error fed back into the prompt). Also raised when the
 *  FR-11 output-contract invariant (`contradiction: true` requires a
 *  non-empty `contradiction_details`) is violated. Carries the raw model
 *  output and validation issues for debugging — never silently swallowed. */
export class GroundingVerificationValidationError extends GroundingVerificationError {
  constructor(
    message: string,
    public readonly issues?: unknown,
    public readonly rawOutput?: unknown,
    options?: { cause?: unknown }
  ) {
    super(message, options);
  }
}

/** §8 "Upstream unavailable" / "Timeout": the LLM provider timed out or
 *  errored on both the initial call and its single retry, or the agent's
 *  30s hard timeout (§7 NFR) elapsed. Distinct from a validation failure
 *  — the Orchestrator MUST treat this identically to a grounding failure
 *  for routing purposes (mark `verification_failed`, route Tier
 *  C/always-escalate-equivalent), never silently skip verification. */
export class GroundingVerificationProviderError extends GroundingVerificationError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** §8 "Clause text is empty or below a minimal length threshold": the
 *  Orchestrator is responsible for short-circuiting BEFORE ever invoking
 *  this agent when `Clause.text` is empty/whitespace-only (this is an
 *  ingestion-quality failure, distinct from a grounding failure — every
 *  field would trivially score "fabricated", which would misleadingly
 *  blame Extraction for an upstream ingestion gap). This error class
 *  exists as a defense-in-depth guard inside `verifyGrounding()` itself,
 *  in case that Orchestrator-side guard is ever missing or bypassed —
 *  see grounding-verification.agent.ts's guard for where this is thrown. */
export class GroundingVerificationEmptyClauseError extends GroundingVerificationError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
