// packages/assistant-core/src/index.ts — Spec 12 §5.3. `answerQuestion` is
// the ONE exported entry point apps/web-console/app/api/assistant/query/
// route.ts calls (§5.6). Wires together classify-question.ts,
// structured-retrieval.ts, vector-retrieval.ts, synthesize-answer.ts, and
// citation-validator.ts per the six-step algorithm below. This file MUST
// NOT import GraphWriter, commitProposal, or any repository
// create()/supersede() method (FR-22) — there is no such import below,
// and there must never be one added.
import type { Session } from "neo4j-driver";
import type { AssistantQueryService, AuditQueryService } from "@sentinel-act/graph-db";
import {
  emptyAssistantGraphContext,
  isEmptyAssistantGraphContext,
  mergeAssistantGraphContexts,
  GraphDbSchemaError
} from "@sentinel-act/graph-db";
import type { AssistantGraphContext } from "@sentinel-act/graph-db";
import { classifyQuestion, classifierAgent as defaultClassifierAgent, type ClassifierAgentLike } from "./classify-question.js";
import { retrieveStructured, type StructuredRetrievalDeps } from "./structured-retrieval.js";
import { retrieveVector as defaultRetrieveVector } from "./vector-retrieval.js";
import { synthesizeAnswer, synthesisAgent as defaultSynthesisAgent, type SynthesizerAgentLike } from "./synthesize-answer.js";
import { buildValidatedCitations } from "./citation-validator.js";
import { sanitizeAssistantGraphContext } from "./guardrails/sanitize-context.js";
import {
  buildUnsupportedRefusal,
  NO_DATA_FOUND_MESSAGE,
  SEMANTIC_SEARCH_UNAVAILABLE_MESSAGE
} from "./guardrails/refusal-templates.js";
import type { AssistantIntent, AssistantQueryRequest, AssistantQueryResponse, ChatMessage, Citation, RetrievalMode } from "./types.js";

export * from "./types.js";
export { classifyQuestion, classifierAgent, truncateConversationHistory, fallbackClassification } from "./classify-question.js";
export type { ClassifierAgentLike, ClassifierGenerateResult } from "./classify-question.js";
export { retrieveStructured } from "./structured-retrieval.js";
export type { StructuredRetrievalDeps, StructuredRetrievalResult } from "./structured-retrieval.js";
export { retrieveVector, VECTOR_RETRIEVAL_TOP_K } from "./vector-retrieval.js";
export type { VectorRetrievalDeps } from "./vector-retrieval.js";
export { synthesizeAnswer, synthesisAgent, synthesisOutputSchema, buildTemplateOnlyFallback } from "./synthesize-answer.js";
export type { SynthesisInput, SynthesisOutput, SynthesizerAgentLike, SynthesizerGenerateResult } from "./synthesize-answer.js";
export { buildValidatedCitations } from "./citation-validator.js";
export * from "./guardrails/sanitize-context.js";
export * from "./guardrails/refusal-templates.js";
export { AssistantError, AssistantProviderError } from "./errors.js";

export interface AnswerQuestionDeps {
  assistantQueryService: Pick<AssistantQueryService, "runTemplate">;
  auditQueryService: Pick<AuditQueryService, "findByObligationId" | "search">;
  /** Opens a NEW session on the assistant's read-only driver — only
   *  called for the vector-retrieval path (§5.3 step 4). */
  neo4jSession: () => Session;
  /** Must use the same embedding model that populated Clause.embedding_ref
   *  (§13 Open Question 2). */
  embedQuestion: (text: string) => Promise<number[]>;
  classifierAgent?: ClassifierAgentLike;
  synthesisAgent?: SynthesizerAgentLike;
  /** Server clock — never client-supplied (FR-2). */
  referenceDateFn: () => string;
  /** Injection seam over retrieveVector (vector-retrieval.ts), defaulting
   *  to the real implementation — lets unit tests substitute a fake
   *  vector-retrieval outcome (including a thrown GraphDbSchemaError/
   *  GraphDbUnavailableError) without module-mocking @sentinel-act/graph-db. */
  retrieveVectorFn?: (
    question: string,
    deps: { neo4jSession: () => Session; embedQuestion: (text: string) => Promise<number[]> }
  ) => Promise<AssistantGraphContext>;
}

type AnswerQuestionOutcome =
  | "unsupported"
  | "clarification"
  | "no_data_found"
  | "insufficient_context"
  | "vector_unavailable"
  | "success";

interface AnswerQuestionLogEntry {
  intent: AssistantIntent;
  retrievalMode: RetrievalMode;
  durationMs: number;
  citedNodeIdsRequested: number;
  citedNodeIdsAccepted: number;
  outcome: AnswerQuestionOutcome;
}

/** NFR-6: "Every answerQuestion call MUST log a structured entry (JSON:
 *  intent, retrievalMode, durationMs, citedNodeIdsRequested vs
 *  citedNodeIdsAccepted counts, outcome)." Never throws — logging must
 *  never break a chat turn. */
function logAnswerQuestion(entry: AnswerQuestionLogEntry): void {
  try {
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", operation: "answerQuestion", ...entry }));
  } catch {
    // Logging must never break a chat turn.
  }
}

/** NFR-6: "Any turn where citedNodeIdsRequested contains an id not
 *  present in citedNodeIdsAccepted MUST be logged at warn level as a
 *  possible hallucination/injection anomaly" — and, per §8's error table,
 *  a heuristic-flagged phrase in retrieved text gets the same warn-level
 *  treatment. Purely observability; never blocks or alters the response. */
function logAnomaly(detail: Record<string, unknown>): void {
  try {
    console.warn(JSON.stringify({ ts: new Date().toISOString(), level: "warn", operation: "answerQuestion", ...detail }));
  } catch {
    // Logging must never break a chat turn.
  }
}

function buildAssistantMessage(content: string, citations: Citation[], retrievalMode: RetrievalMode): ChatMessage {
  return {
    role: "assistant",
    content,
    citations: citations.length > 0 ? citations : undefined,
    retrievalMode,
    createdAt: new Date().toISOString()
  };
}

/** §5.3 steps 1-6. The only function apps/web-console/app/api/assistant/
 *  query/route.ts calls. */
export async function answerQuestion(request: AssistantQueryRequest, deps: AnswerQuestionDeps): Promise<AssistantQueryResponse> {
  const start = Date.now();
  const referenceDate = deps.referenceDateFn();

  // Step 1 (FR-1): classify using ONLY question text + truncated history —
  // never clause/circular/obligation text, since retrieval hasn't
  // happened yet at this point in the algorithm.
  const classification = await classifyQuestion(
    request.question,
    request.conversationHistory,
    referenceDate,
    deps.classifierAgent ?? defaultClassifierAgent
  );

  // Step 2 (FR-4): unsupported -> canned refusal, no graph query, no
  // synthesis call, ever.
  if (classification.intent === "unsupported") {
    const message = buildAssistantMessage(buildUnsupportedRefusal(classification.unsupportedReason), [], "none");
    logAnswerQuestion({
      intent: classification.intent,
      retrievalMode: "none",
      durationMs: Date.now() - start,
      citedNodeIdsRequested: 0,
      citedNodeIdsAccepted: 0,
      outcome: "unsupported"
    });
    return { message, intent: classification.intent, retrievalMode: "none" };
  }

  let context: AssistantGraphContext = emptyAssistantGraphContext();
  let retrievalMode: RetrievalMode = "none";

  const structuredRetrievalDeps: StructuredRetrievalDeps = {
    assistantQueryService: deps.assistantQueryService,
    auditQueryService: deps.auditQueryService
  };

  // Step 3 (FR-5, FR-9): structured retrieval for any of the eight
  // template/AuditQueryService-backed intents.
  if (classification.intent !== "semantic_lookup") {
    const structuredResult = await retrieveStructured(classification.intent, classification.slots, structuredRetrievalDeps);

    if (structuredResult.clarification) {
      // FR-9/FR-28: a clarification is NOT an error state — the
      // conversation continues naturally, no graph query beyond the
      // (already-attempted) validation, no synthesis call.
      const message = buildAssistantMessage(structuredResult.clarification.prompt, [], "none");
      logAnswerQuestion({
        intent: classification.intent,
        retrievalMode: "none",
        durationMs: Date.now() - start,
        citedNodeIdsRequested: 0,
        citedNodeIdsAccepted: 0,
        outcome: "clarification"
      });
      return { message, intent: classification.intent, retrievalMode: "none", clarification: structuredResult.clarification };
    }

    context = structuredResult.context;
    retrievalMode = "structured";
  }

  // Step 4 (FR-10, FR-11): semantic_lookup always goes to vector
  // retrieval; a structured path that returned zero rows ALSO falls back
  // to vector before concluding "no data found" — a structured miss does
  // not automatically mean the graph has nothing relevant.
  const structuredMiss = retrievalMode === "structured" && isEmptyAssistantGraphContext(context);
  if (classification.intent === "semantic_lookup" || structuredMiss) {
    try {
      const retrieveVectorFn = deps.retrieveVectorFn ?? defaultRetrieveVector;
      const vectorContext = await retrieveVectorFn(request.question, {
        neo4jSession: deps.neo4jSession,
        embedQuestion: deps.embedQuestion
      });
      // FR-12: assemble a single AssistantGraphContext from whichever
      // path(s) ran — a structured miss's (empty) context merged with the
      // vector fallback's is just the vector context, but merging (not
      // replacing) keeps this correct even if a future template ever
      // returns partial rows alongside a still-relevant vector hit.
      context = structuredMiss ? mergeAssistantGraphContexts(context, vectorContext) : vectorContext;
      retrievalMode = "vector";
    } catch (error) {
      if (error instanceof GraphDbSchemaError) {
        // §8: vector index missing/misconfigured — friendly message, not
        // a 500. (The spec's further "retry the structured path" nuance
        // does not apply here: a structured path either already ran and
        // came back empty, or this was semantic_lookup with no structured
        // slots to retry with.)
        const message = buildAssistantMessage(SEMANTIC_SEARCH_UNAVAILABLE_MESSAGE, [], retrievalMode);
        logAnswerQuestion({
          intent: classification.intent,
          retrievalMode,
          durationMs: Date.now() - start,
          citedNodeIdsRequested: 0,
          citedNodeIdsAccepted: 0,
          outcome: "vector_unavailable"
        });
        return { message, intent: classification.intent, retrievalMode };
      }
      throw error; // GraphDbUnavailableError / AssistantProviderError etc. -> route handler maps to 503 (§8)
    }
  }

  // Step 5 (FR-14): empty context after everything above -> the honest
  // "no data found" response. No synthesis call — an LLM is never asked
  // to produce an answer from nothing.
  if (isEmptyAssistantGraphContext(context)) {
    const message = buildAssistantMessage(NO_DATA_FOUND_MESSAGE, [], retrievalMode);
    logAnswerQuestion({
      intent: classification.intent,
      retrievalMode,
      durationMs: Date.now() - start,
      citedNodeIdsRequested: 0,
      citedNodeIdsAccepted: 0,
      outcome: "no_data_found"
    });
    return { message, intent: classification.intent, retrievalMode };
  }

  // §8/NFR-6: the heuristic injection scan is logging-only and runs
  // independently of prompt construction inside synthesizeAnswer itself —
  // computed here too so a flagged anomaly is captured regardless of
  // whether synthesis ultimately succeeds, fails, or falls back.
  const { injectionAnomalies } = sanitizeAssistantGraphContext(context);

  // Step 6 (FR-13, FR-15, FR-16): synthesize, then validate citations.
  const synthesisOutput = await synthesizeAnswer(
    {
      question: request.question,
      conversationHistory: request.conversationHistory,
      retrievedContext: context,
      retrievalMode,
      referenceDate
    },
    deps.synthesisAgent ?? defaultSynthesisAgent
  );

  if (synthesisOutput.insufficientContext) {
    // FR-15: the model's own admission of insufficient grounding
    // overrides whatever answerText it produced alongside the flag.
    const message = buildAssistantMessage(NO_DATA_FOUND_MESSAGE, [], retrievalMode);
    logAnswerQuestion({
      intent: classification.intent,
      retrievalMode,
      durationMs: Date.now() - start,
      citedNodeIdsRequested: synthesisOutput.citedNodeIds.length,
      citedNodeIdsAccepted: 0,
      outcome: "insufficient_context"
    });
    return { message, intent: classification.intent, retrievalMode };
  }

  const citations = buildValidatedCitations(synthesisOutput.citedNodeIds, context);
  const acceptedIds = new Set(citations.map((citation) => citation.id));
  const droppedNodeIds = synthesisOutput.citedNodeIds.filter((id) => !acceptedIds.has(id));

  if (droppedNodeIds.length > 0) {
    logAnomaly({
      reason: "citedNodeIds contained an id not present in the retrieved context — possible hallucination/injection",
      intent: classification.intent,
      droppedNodeIds
    });
  }
  if (injectionAnomalies.length > 0) {
    logAnomaly({
      reason: "retrieved context text matched a prompt-injection heuristic pattern",
      intent: classification.intent,
      injectionAnomalies
    });
  }

  const message = buildAssistantMessage(synthesisOutput.answerText, citations, retrievalMode);
  logAnswerQuestion({
    intent: classification.intent,
    retrievalMode,
    durationMs: Date.now() - start,
    citedNodeIdsRequested: synthesisOutput.citedNodeIds.length,
    citedNodeIdsAccepted: citations.length,
    outcome: "success"
  });

  return { message, intent: classification.intent, retrievalMode };
}
