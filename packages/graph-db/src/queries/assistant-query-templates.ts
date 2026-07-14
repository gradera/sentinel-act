// Cypher template registry for the Conversational Assistant — Spec 12 §4.2.
// Five templates. All are MATCH/OPTIONAL MATCH/WHERE/WITH/RETURN/ORDER
// BY/LIMIT only — no CREATE, MERGE, SET, DELETE, DETACH, or CALL apoc.*
// write procedures anywhere in this file (FR-7). This is enforced by an
// automated static-analysis test (assistant-query-templates.test.ts), not
// just review discipline (§10).
//
// ***** Tier C / ESCALATE independence guard — read this before editing
// T2 or T5's Cypher *****
//
// AuditQueryService (../audit-query.ts) enforces FR-11a: an in-progress
// Tier C (or ESCALATE, see that file's FR_11A_GUARD doc comment for the
// full derivation) maker HumanReview must never be visible on a read-only
// surface before the checker's decision also exists. This unit's three
// AuditQueryService-backed intents (review_history_by_*) inherit that
// guard for free by calling AuditQueryService unmodified (FR-6). This
// file's own two templates that touch `(o)-[:REVIEWED_BY]->(hr:HumanReview)`
// — T2 (obligation_by_id_with_lineage) and T5
// (reviews_by_category_and_date_range) — do NOT get the guard for free:
// they are new Cypher this unit writes itself, structurally different
// MATCH shapes than AuditQueryService's, so the guard must be applied
// natively here. See docs/specs/12-conversational-assistant.md's kickoff
// notes ("Cross-spec coordination notes") for why this can't just call
// AuditQueryService instead — T2/T5 return different data shapes (full
// Obligation lineage in one row vs. reviewed-obligations-in-a-window) that
// AuditQueryService's two query shapes don't produce.
import { z } from "zod";

/** Same rule as AuditQueryService's FR_11A_GUARD (../audit-query.ts),
 *  applied natively here since T2/T5 are new Cypher, not calls into that
 *  service. Kept as an identical literal (not imported — that constant is
 *  private to audit-query.ts and these are unrelated query shapes) so a
 *  future reader who greps for "tier_c_review\", \"escalated\"" finds both
 *  enforcement points together. If AuditQueryService's guard is ever
 *  changed, this one must change with it. */
const TIER_C_INDEPENDENCE_GUARD = 'NOT (hr.tier = "C" AND o.status IN ["tier_c_review", "escalated"])';

export interface AssistantQueryTemplate<P extends z.ZodTypeAny = z.ZodTypeAny> {
  id: string;
  description: string; // shown to the classifier LLM as part of intent selection context
  paramsSchema: P;
  cypher: string;
  defaultLimit: number; // used when params.limit is absent
  maxLimit: number; // hard cap regardless of what a caller requests
}

// T1 — "what obligations changed/were introduced for stockbrokers last month"
export const obligationsByCategoryAndDateRangeTemplate: AssistantQueryTemplate = {
  id: "obligations_by_category_and_date_range",
  description:
    "Obligations whose valid_from falls within [dateFrom, dateTo] and that APPLIES_TO the given IntermediaryCategory.",
  paramsSchema: z.object({
    categoryName: z.string().min(1),
    dateFrom: z.string(), // ISO date
    dateTo: z.string(), // ISO date
    limit: z.number().int().positive().max(50).default(20)
  }),
  cypher: `
    MATCH (o:Obligation)-[:APPLIES_TO]->(ic:IntermediaryCategory {name: $categoryName})
    WHERE o.valid_from >= date($dateFrom) AND o.valid_from <= date($dateTo)
    OPTIONAL MATCH (o)-[:DERIVED_FROM]->(cl:Clause)-[:PART_OF]->(c:Circular)
    RETURN o, cl, c
    ORDER BY o.valid_from DESC
    LIMIT $limit
  `,
  defaultLimit: 20,
  maxLimit: 50
};

// T2 — "what does obligation X require / why was it introduced / who
// reviewed it" (lineage view — includes reviews, so the Tier C/ESCALATE
// independence guard applies, see file-level doc comment above)
export const obligationByIdWithLineageTemplate: AssistantQueryTemplate = {
  id: "obligation_by_id_with_lineage",
  description: "Full lineage (Clause, Circular, ProcessTask, HumanReview) for one Obligation, by exact obligation_id.",
  paramsSchema: z.object({ obligationId: z.string().uuid() }),
  cypher: `
    MATCH (o:Obligation {obligation_id: $obligationId})
    OPTIONAL MATCH (o)-[:DERIVED_FROM]->(cl:Clause)-[:PART_OF]->(c:Circular)
    OPTIONAL MATCH (o)-[:MAPPED_TO]->(pt:ProcessTask)
    OPTIONAL MATCH (o)-[:REVIEWED_BY]->(hr:HumanReview)
      WHERE ${TIER_C_INDEPENDENCE_GUARD}
    RETURN o, cl, c, collect(DISTINCT pt) AS tasks, collect(DISTINCT hr) AS reviews
  `,
  defaultLimit: 1,
  maxLimit: 1
};

// T3 — "what's in the CUSPA master circular" / "tell me about circular <id>"
export const circularByIdOrTitleTemplate: AssistantQueryTemplate = {
  id: "circular_by_id_or_title",
  description:
    "A Circular by exact circular_id, or a case-insensitive substring match on title, plus its Clauses and derived Obligations.",
  paramsSchema: z
    .object({
      circularId: z.string().nullable(),
      titleContains: z.string().nullable(),
      limit: z.number().int().positive().max(50).default(10)
    })
    .refine((v) => v.circularId !== null || v.titleContains !== null, {
      message: "circularId or titleContains is required"
    }),
  cypher: `
    MATCH (c:Circular)
    WHERE ($circularId IS NOT NULL AND c.circular_id = $circularId)
       OR ($titleContains IS NOT NULL AND toLower(c.title) CONTAINS toLower($titleContains))
    OPTIONAL MATCH (cl:Clause)-[:PART_OF]->(c)
    OPTIONAL MATCH (o:Obligation)-[:DERIVED_FROM]->(cl)
    RETURN c, collect(DISTINCT cl) AS clauses, collect(DISTINCT o) AS obligations
    LIMIT $limit
  `,
  defaultLimit: 10,
  maxLimit: 50
};

// T4 — "what's currently in Tier C review" / "show rejected obligations"
export const obligationsByStatusTemplate: AssistantQueryTemplate = {
  id: "obligations_by_status",
  description:
    "Obligations filtered by Obligation.status (proposed | tier_a_committed | tier_b_review | tier_c_review | escalated | committed | rejected).",
  paramsSchema: z.object({
    status: z.enum(["proposed", "tier_a_committed", "tier_b_review", "tier_c_review", "escalated", "committed", "rejected"]),
    limit: z.number().int().positive().max(50).default(20)
  }),
  cypher: `
    MATCH (o:Obligation {status: $status})
    OPTIONAL MATCH (o)-[:DERIVED_FROM]->(cl:Clause)-[:PART_OF]->(c:Circular)
    RETURN o, cl, c
    ORDER BY o.recorded_at DESC
    LIMIT $limit
  `,
  defaultLimit: 20,
  maxLimit: 50
};

// T5 — "what did we approve/reject for stockbrokers last month" (this
// template's whole purpose is surfacing reviews, so it MATCHes — not
// OPTIONAL MATCHes — HumanReview; the Tier C/ESCALATE independence guard
// applies here too, see file-level doc comment above)
export const reviewsByCategoryAndDateRangeTemplate: AssistantQueryTemplate = {
  id: "reviews_by_category_and_date_range",
  description:
    "HumanReview facts for Obligations that APPLIES_TO the given IntermediaryCategory, decided within [dateFrom, dateTo], optionally filtered by decision.",
  paramsSchema: z.object({
    categoryName: z.string().min(1),
    dateFrom: z.string(),
    dateTo: z.string(),
    decision: z.enum(["approve", "reject"]).nullable(),
    limit: z.number().int().positive().max(50).default(20)
  }),
  cypher: `
    MATCH (o:Obligation)-[:APPLIES_TO]->(ic:IntermediaryCategory {name: $categoryName})
    MATCH (o)-[:REVIEWED_BY]->(hr:HumanReview)
    WHERE hr.decided_at >= datetime($dateFrom) AND hr.decided_at <= datetime($dateTo)
      AND ($decision IS NULL OR hr.decision = $decision)
      AND ${TIER_C_INDEPENDENCE_GUARD}
    OPTIONAL MATCH (o)-[:DERIVED_FROM]->(cl:Clause)-[:PART_OF]->(c:Circular)
    RETURN o, hr, cl, c
    ORDER BY hr.decided_at DESC
    LIMIT $limit
  `,
  defaultLimit: 20,
  maxLimit: 50
};

export const ASSISTANT_QUERY_TEMPLATES = [
  obligationsByCategoryAndDateRangeTemplate,
  obligationByIdWithLineageTemplate,
  circularByIdOrTitleTemplate,
  obligationsByStatusTemplate,
  reviewsByCategoryAndDateRangeTemplate
] as const;

export function findAssistantQueryTemplate(templateId: string): AssistantQueryTemplate | undefined {
  return ASSISTANT_QUERY_TEMPLATES.find((template) => template.id === templateId);
}
