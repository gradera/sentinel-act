// Public types for the Conversational Assistant — Spec 12 §4.1.
// Framework-agnostic: no Next.js, no direct Neo4j driver. AssistantGraphContext
// itself is NOT redefined here — it's imported from @sentinel-act/graph-db
// (packages/graph-db/src/queries/assistant-query.types.ts, §5.1), so the two
// packages can never drift apart on that shape.
import type { ObligationStatus, ReviewDecision } from "@sentinel-act/graph-schema";

export type { AssistantGraphContext } from "@sentinel-act/graph-db";

/** The finite set of question shapes this unit can answer. There is no
 *  "generate arbitrary Cypher" member of this enum, by design (§6, FR-4).
 *  Exactly ten values — a question shaped as an approval, rejection,
 *  edit, deletion, or override request has no member to map to and MUST
 *  classify as "unsupported". */
export const ASSISTANT_INTENTS = [
  "obligations_by_category_and_date_range", // T1, new template
  "obligation_by_id_with_lineage", // T2, new template
  "circular_by_id_or_title", // T3, new template
  "obligations_by_status", // T4, new template
  "reviews_by_category_and_date_range", // T5, new template
  "review_history_by_obligation", // reuses AuditQueryService.findByObligationId
  "review_history_by_circular", // reuses AuditQueryService.search({ circularId })
  "review_history_by_reviewer", // reuses AuditQueryService.search({ reviewerId, ... })
  "semantic_lookup", // vector path, findSimilarClauses
  "unsupported" // out of scope / write-shaped / off-topic — canned refusal
] as const;

export type AssistantIntent = (typeof ASSISTANT_INTENTS)[number];

/** Compile-time guarantee that ASSISTANT_INTENTS has exactly ten members
 *  (Acceptance Criterion basis for FR-1/FR-4) — this line fails to
 *  typecheck if the tuple's length ever changes without this being
 *  updated deliberately alongside it. */
type AssertExactlyTenIntents = (typeof ASSISTANT_INTENTS)["length"] extends 10 ? true : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _assertExactlyTenIntents: AssertExactlyTenIntents = true;

/** Slots the classifier extracts from the question (+ resolved relative
 *  dates — see FR-2). All nullable; which ones are required depends on
 *  the selected intent's own param schema (§4.2). */
export interface AssistantSlots {
  categoryName: string | null; // IntermediaryCategory.name, e.g. "Stockbroker"
  obligationId: string | null;
  circularId: string | null;
  titleContains: string | null;
  status: ObligationStatus | null;
  reviewerId: string | null;
  decision: ReviewDecision | null;
  dateFrom: string | null; // ISO date, resolved from relative phrases
  dateTo: string | null; // ISO date, resolved from relative phrases
}

export interface QuestionClassification {
  intent: AssistantIntent;
  confidence: number; // 0..1, model self-reported
  slots: AssistantSlots;
  unsupportedReason: string | null; // populated only when intent === "unsupported"
}

export type RetrievalMode = "structured" | "vector" | "none";

export type CitationType = "Circular" | "Clause" | "Obligation" | "ProcessTask" | "HumanReview";

export interface Citation {
  type: CitationType;
  id: string;
  label: string; // e.g. "Circular: CUSPA Master Circular", "Clause ¶46", "Obligation (client unpaid securities)"
  href: string; // deep link — see §4.6 for the exact convention
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  retrievalMode?: RetrievalMode;
  createdAt: string; // ISO datetime
}

/** Body of POST /api/assistant/query. No sessionId / server-side history
 *  in v1 — the client resends the trailing window of its own transcript
 *  (§13, Open Question 4). */
export interface AssistantQueryRequest {
  question: string;
  conversationHistory: ChatMessage[]; // most recent turns; server truncates (§7, NFR-5)
}

export interface AssistantQueryResponse {
  message: ChatMessage; // role: "assistant"
  intent: AssistantIntent;
  retrievalMode: RetrievalMode;
  /** Present instead of a full answer when a structured intent was
   *  selected but a required slot could not be resolved (§6, FR-9). */
  clarification?: { missingSlots: (keyof AssistantSlots)[]; prompt: string };
}

// AssistantGraphContext is re-exported (via the `export type` statement
// near the top of this file) so downstream callers in this package
// (structured-retrieval.ts, synthesize-answer.ts, etc.) can import
// everything they need from "./types.js" without also reaching into
// @sentinel-act/graph-db directly for this one type.
