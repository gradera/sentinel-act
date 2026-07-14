// Spec 12 §8 error-handling table, for POST /api/assistant/query only.
// Mirrors audit-errors.ts's mapAuditQueryError pattern exactly (try this
// mapper first — after mapSessionError — in the route's catch block, chain
// with `??` into a route-specific fallback), but for the error taxonomy
// answerQuestion() can actually throw: @sentinel-act/assistant-core's
// AssistantProviderError (LLM provider unavailable after one retry, §8's
// "classification or synthesis call" row) and @sentinel-act/graph-db's
// GraphDbUnavailableError (the assistant's read-only driver/session
// itself failing) or a raw transient Neo4j driver error propagating
// unwrapped (AssistantQueryService/AuditQueryService/vector-retrieval.ts's
// session.close() in a `finally` never swallows the original error).
//
// Kept in its own file, not merged into audit-errors.ts, because the two
// units throw genuinely different error taxonomies (AssistantProviderError
// has no equivalent in the audit/export surface — Spec 10's routes never
// call an LLM) even though both ultimately want a 503 for "service
// temporarily unavailable".
import { NextResponse } from "next/server";
import { GraphDbUnavailableError } from "@sentinel-act/graph-db";
import { AssistantProviderError } from "@sentinel-act/assistant-core";
import { jsonError } from "./route-errors";

/** Duck-types neo4j-driver's own `Neo4jError` — same check as
 *  audit-errors.ts's `isTransientDriverError`, kept as its own copy here
 *  (rather than imported) since that function isn't exported from
 *  audit-errors.ts and the two units are deliberately not sharing a
 *  common error-mapping module (see this file's top-of-file comment). */
function isTransientDriverError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  if (typeof code !== "string") {
    return false;
  }
  return code.includes("ServiceUnavailable") || code.includes("SessionExpired") || code.includes("TransientError");
}

/** Maps answerQuestion()'s thrown errors to the §8-shaped response.
 *  Returns `null` for anything it doesn't recognize so the route handler
 *  chains: `mapSessionError(err) ?? mapAssistantError(err) ?? jsonError(500, "INTERNAL_ERROR")`. */
export function mapAssistantError(err: unknown): NextResponse | null {
  if (err instanceof AssistantProviderError) {
    // §8: "LLM provider unavailable/timeout ... on a second failure, 503
    // ... the failure is logged with which call (classify vs synthesize)
    // failed." The logging itself already happened inside
    // classify-question.ts/synthesize-answer.ts before this error was
    // thrown (both call sites' own doc comments) — this mapper only maps
    // the status code.
    return jsonError(503, "ASSISTANT_UNAVAILABLE", "assistant temporarily unavailable, please try again shortly.");
  }
  if (err instanceof GraphDbUnavailableError || isTransientDriverError(err)) {
    return jsonError(503, "ASSISTANT_UNAVAILABLE", "assistant temporarily unavailable, please try again shortly.");
  }
  return null;
}
