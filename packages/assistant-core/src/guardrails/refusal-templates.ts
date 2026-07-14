// refusal-templates.ts — Spec 12 §5.1, §6, §8. Canned, non-LLM-generated
// copy for the three "don't call synthesizeAnswer at all" paths: an
// unsupported (write-shaped/off-topic) question (FR-4, Acceptance
// Criterion 4), an empty-context/insufficient-context "no data found"
// response (FR-14/FR-15), and infrastructure failures (§8's error table).
// Kept as plain strings, not templates rendered by an LLM, so these
// responses can never themselves be an injection vector.

/** FR-4 / Acceptance Criterion 4: "the response is the canned refusal copy
 *  directing the user to the Web Governance Console or Slack." */
export function buildUnsupportedRefusal(unsupportedReason: string | null): string {
  const reason = unsupportedReason ?? "this assistant is read-only and can't take governance actions.";
  return (
    `I can't do that — ${reason} ` +
    "If you need to approve, reject, or otherwise act on an obligation, use the Web Governance Console's " +
    "Operator queue, or the Slack approval flow if it's enabled for your team."
  );
}

/** FR-14/FR-15: "no data found" — used both when retrieval (structured +
 *  the FR-11 vector fallback) produced an empty AssistantGraphContext, and
 *  when synthesizeAnswer itself reports insufficientContext: true. Never
 *  the model's own attempted answerText in that second case — this canned
 *  copy always wins over whatever prose the model produced alongside the
 *  flag. */
export const NO_DATA_FOUND_MESSAGE =
  "I couldn't find anything in the compliance graph that answers this question. Try naming a specific circular, " +
  "obligation id, or intermediary category, or rephrase your question.";

/** §8: "Vector index missing/misconfigured" row. */
export const SEMANTIC_SEARCH_UNAVAILABLE_MESSAGE =
  "Semantic search is temporarily unavailable — try naming a specific circular, obligation id, or intermediary " +
  "category instead.";

/** §8: "Neo4j (assistant read-only driver) unavailable" and "LLM provider
 *  unavailable/timeout" rows both surface this same friendly message to
 *  the UI; the route handler (POST /api/assistant/query) is what actually
 *  maps the underlying error to a 503 alongside it. */
export const ASSISTANT_UNAVAILABLE_MESSAGE = "I can't reach the compliance graph right now. Please try again in a moment.";

/** §2 Non-Goals: "export this" gets a canned redirection, not an attempt
 *  to generate a file here. Not currently wired to a dedicated intent
 *  (there is no "export" member of AssistantIntent — such a question
 *  classifies as unsupported per FR-4), but kept here as the copy to use
 *  if/when that redirection is surfaced more specifically. */
export const EXPORT_REDIRECT_MESSAGE =
  "I can't generate exports or reports myself — please use the Compliance Register Export panel in the Web " +
  "Governance Console's Observer mode for that.";
