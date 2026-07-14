// Error taxonomy for @sentinel-act/assistant-core (mirrors packages/
// graph-db/src/errors.ts's "every path throws a named class, never a bare
// Error" convention, so callers — chiefly the API route handler, §5.6 —
// can branch on `instanceof` to build the §8 error-handling table's exact
// status-code mapping).
export class AssistantError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** §8: "LLM provider unavailable/timeout (classification or synthesis
 *  call) ... on a second failure, 503 ... the failure is logged with
 *  which call (classify vs synthesize) failed." Thrown only when the
 *  underlying Agent.generate() call itself fails (transport/provider
 *  error) after one retry — a schema-validation failure is a distinct,
 *  non-throwing degradation path (FR-3/FR-15), never this error. */
export class AssistantProviderError extends AssistantError {
  constructor(
    public readonly call: "classify" | "synthesize",
    options?: { cause?: unknown }
  ) {
    super(`Assistant ${call} call failed after one retry.`, options);
  }
}
