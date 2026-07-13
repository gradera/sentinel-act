// Typed errors for the Change and Delta Agent (Spec 06 §6 FR-1/FR-3, §8).
// These are caller-contract violations (the Orchestrator should not have
// invoked this unit, or invoked it against a stale target) — deliberately
// distinct from the recoverable, degrade-to-unresolved handling of an LLM
// alignment failure, which never throws (FR-14).

/** FR-1 / §8. Thrown when `resolveScope` returns "not_applicable" — the
 *  trigger event is not an amendment this unit can process (e.g.
 *  changeType "new" with a null amendmentContext / targetCircularId). */
export class ChangeAndDeltaNotApplicableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeAndDeltaNotApplicableError";
  }
}

/** FR-3 / §8. Thrown when the target circular no longer exists or is no
 *  longer live (`valid_to` set) at the time this unit runs — defense in
 *  depth against a stale/wrong AmendmentContext. */
export class ChangeAndDeltaStaleTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeAndDeltaStaleTargetError";
  }
}
