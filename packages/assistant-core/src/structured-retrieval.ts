// structured-retrieval.ts — Spec 12 §5.3 step 3, §6 (FR-5, FR-6, FR-9).
// Dispatches a classified structured intent to either
// AssistantQueryService.runTemplate (the five new templates, §4.2) or the
// matching AuditQueryService method (the three review_history_* intents,
// reused unmodified — FR-6). Validates/resolves required slots before any
// Cypher runs; returns a `clarification` response (never a guess or a
// silent error) when a required slot is missing or fails a template's own
// param schema (FR-9). This file MUST NOT import GraphWriter,
// commitProposal, or any repository create()/supersede() method (FR-22) —
// there is no such import below, and there must never be one added.
import type { AssistantQueryService, AuditQueryService, AuditTrailRow } from "@sentinel-act/graph-db";
import { ValidationError, emptyAssistantGraphContext, mergeAssistantGraphContexts } from "@sentinel-act/graph-db";
import type { AssistantGraphContext } from "@sentinel-act/graph-db";
import type { AssistantIntent, AssistantQueryResponse, AssistantSlots } from "./types.js";

export interface StructuredRetrievalDeps {
  assistantQueryService: Pick<AssistantQueryService, "runTemplate">;
  auditQueryService: Pick<AuditQueryService, "findByObligationId" | "search">;
}

export interface StructuredRetrievalResult {
  context: AssistantGraphContext;
  /** Present iff a required slot for the selected intent was missing or
   *  failed a template's own param validation (FR-9) — the caller
   *  (packages/assistant-core/src/index.ts) short-circuits to this
   *  clarification response instead of calling synthesizeAnswer. */
  clarification?: NonNullable<AssistantQueryResponse["clarification"]>;
}

const CLARIFICATION_PROMPTS: Partial<Record<keyof AssistantSlots, string>> = {
  categoryName: "Which intermediary category did you mean — for example, Stockbroker or Investment Adviser?",
  obligationId:
    "Which obligation did you mean? Please give its obligation id, or rephrase your question so I can look it up by description instead.",
  circularId: "Which circular did you mean? Please give its circular id or (part of) its title.",
  status: "Which status did you mean — for example, tier_c_review, committed, or rejected?",
  reviewerId: "Which reviewer did you mean? Please give their reviewer id.",
  dateFrom: "What date range did you mean — for example, \"last month,\" or a specific start and end date?",
  dateTo: "What date range did you mean — for example, \"last month,\" or a specific start and end date?"
};

function clarificationFor(missingSlots: (keyof AssistantSlots)[]): NonNullable<AssistantQueryResponse["clarification"]> {
  const prompts = new Set(
    missingSlots.map((slot) => CLARIFICATION_PROMPTS[slot] ?? `Could you clarify what you meant by "${slot}"?`)
  );
  return { missingSlots, prompt: [...prompts].join(" ") };
}

function requireSlots(slots: AssistantSlots, required: (keyof AssistantSlots)[]): (keyof AssistantSlots)[] {
  return required.filter((key) => {
    const value = slots[key];
    return value === null || value === undefined || (typeof value === "string" && value.trim().length === 0);
  });
}

/** FR-9's "invalid," not just "missing," case: a template's own zod
 *  schema rejected a present-but-malformed slot value (e.g. an
 *  obligationId that isn't a UUID). Converted into the same clarification
 *  shape as a missing slot — never a 500. */
async function runTemplateOrClarify(
  deps: StructuredRetrievalDeps,
  templateId: string,
  rawParams: Record<string, unknown>,
  slotsInvolved: (keyof AssistantSlots)[]
): Promise<StructuredRetrievalResult> {
  try {
    const context = await deps.assistantQueryService.runTemplate(templateId, rawParams);
    return { context };
  } catch (error) {
    if (error instanceof ValidationError) {
      return { context: emptyAssistantGraphContext(), clarification: clarificationFor(slotsInvolved) };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// AuditQueryService row -> AssistantGraphContext bridge (review_history_*
// intents, FR-6).
//
// AuditTrailRow's obligation/processTasks are narrower Pick<> subsets than
// AssistantGraphContext's own (missing trigger_event/deadline_rule/
// responsible_role/derived_from_clause_id on Obligation, and owner_role/
// sla_hours on ProcessTask — Spec 10's audit trail never needed those
// fields, Spec 12's citation/synthesis context does). Rather than widen
// AuditQueryService's Cypher (which would be exactly the "second, parallel
// implementation" FR-6 forbids) or fabricate placeholder values that could
// leak into a synthesized answer, this bridge best-effort enriches each
// distinct Obligation via the ALREADY-REQUIRED obligation_by_id_with_lineage
// template (T2, intent #2) — reusing an existing, already-tested read path
// for a different purpose, not adding a new one. Enrichment intentionally
// does NOT merge T2's own HumanReview rows: AuditQueryService's filtered
// review set (e.g. one specific reviewerId/date range) must remain the
// sole source of truth for humanReviews on these three intents, or a
// broader unfiltered review set from T2 would leak into a narrowly-scoped
// question's context.
// ---------------------------------------------------------------------------

function baseContextFromAuditRows(rows: AuditTrailRow[]): AssistantGraphContext {
  const context = emptyAssistantGraphContext();
  const obligationIds = new Set<string>();
  const clauseIds = new Set<string>();
  const circularIds = new Set<string>();
  const taskIds = new Set<string>();
  const reviewIds = new Set<string>();

  for (const row of rows) {
    if (!obligationIds.has(row.obligation.obligation_id)) {
      obligationIds.add(row.obligation.obligation_id);
      context.obligations.push({
        obligation_id: row.obligation.obligation_id,
        category: row.obligation.category,
        requirement_text: row.obligation.requirement_text,
        // Not present on AuditTrailRow — left blank pending enrichment
        // (see file-level doc comment above); never surfaced to
        // synthesis as a claimed fact, only as an absence.
        trigger_event: "",
        deadline_rule: "",
        responsible_role: "",
        penalty_ref: row.obligation.penalty_ref,
        status: row.obligation.status,
        confidence_score: row.obligation.confidence_score,
        grounding_score: row.obligation.grounding_score,
        derived_from_clause_id: row.clause?.clause_id ?? ""
      });
    }

    if (row.clause && !clauseIds.has(row.clause.clause_id)) {
      clauseIds.add(row.clause.clause_id);
      context.clauses.push({
        clause_id: row.clause.clause_id,
        para_ref: row.clause.para_ref,
        // Not present on AuditTrailRow's Clause Pick<>; enrichment fills
        // this in when available.
        text: "",
        circular_id: row.circular?.circular_id ?? ""
      });
    }

    if (row.circular && !circularIds.has(row.circular.circular_id)) {
      circularIds.add(row.circular.circular_id);
      context.circulars.push({ ...row.circular });
    }

    for (const task of row.processTasks) {
      if (!taskIds.has(task.task_id)) {
        taskIds.add(task.task_id);
        context.processTasks.push({
          task_id: task.task_id,
          task_name: task.task_name,
          // Not present on AuditTrailRow's ProcessTask Pick<>; enrichment
          // fills these in when available.
          owner_role: "",
          sla_hours: 0,
          risk_score: task.risk_score,
          obligation_id: row.obligation.obligation_id
        });
      }
    }

    if (!reviewIds.has(row.review.review_id)) {
      reviewIds.add(row.review.review_id);
      context.humanReviews.push({
        review_id: row.review.review_id,
        reviewer_id: row.review.reviewer_id,
        tier: row.review.tier,
        decision: row.review.decision,
        rationale: row.review.rationale,
        decided_at: row.review.decided_at,
        obligation_id: row.review.obligation_id
      });
    }
  }

  return context;
}

async function enrichObligationLineage(
  base: AssistantGraphContext,
  deps: StructuredRetrievalDeps
): Promise<AssistantGraphContext> {
  let context = base;
  for (const obligation of base.obligations) {
    try {
      const enriched = await deps.assistantQueryService.runTemplate("obligation_by_id_with_lineage", {
        obligationId: obligation.obligation_id
      });
      const merged = mergeAssistantGraphContexts(context, enriched);
      // Deliberately preserve AuditQueryService's own (possibly filtered)
      // humanReviews — see the file-level doc comment above for why T2's
      // unfiltered set must never be merged in here.
      context = { ...merged, humanReviews: context.humanReviews };
    } catch {
      // Best-effort enrichment only — the base (placeholder-blank)
      // obligation fields from the audit row still stand if this fails.
    }
  }
  return context;
}

async function auditRowsToContext(rows: AuditTrailRow[], deps: StructuredRetrievalDeps): Promise<AssistantGraphContext> {
  const base = baseContextFromAuditRows(rows);
  return enrichObligationLineage(base, deps);
}

// ---------------------------------------------------------------------------
// Dispatch (§6, FR-5, FR-9).
// ---------------------------------------------------------------------------

export async function retrieveStructured(
  intent: AssistantIntent,
  slots: AssistantSlots,
  deps: StructuredRetrievalDeps
): Promise<StructuredRetrievalResult> {
  switch (intent) {
    case "obligations_by_category_and_date_range": {
      const required: (keyof AssistantSlots)[] = ["categoryName", "dateFrom", "dateTo"];
      const missing = requireSlots(slots, required);
      if (missing.length > 0) {
        return { context: emptyAssistantGraphContext(), clarification: clarificationFor(missing) };
      }
      return runTemplateOrClarify(
        deps,
        "obligations_by_category_and_date_range",
        { categoryName: slots.categoryName, dateFrom: slots.dateFrom, dateTo: slots.dateTo },
        required
      );
    }

    case "obligation_by_id_with_lineage": {
      const required: (keyof AssistantSlots)[] = ["obligationId"];
      const missing = requireSlots(slots, required);
      if (missing.length > 0) {
        return { context: emptyAssistantGraphContext(), clarification: clarificationFor(missing) };
      }
      return runTemplateOrClarify(deps, "obligation_by_id_with_lineage", { obligationId: slots.obligationId }, required);
    }

    case "circular_by_id_or_title": {
      if (!slots.circularId && !slots.titleContains) {
        return {
          context: emptyAssistantGraphContext(),
          clarification: clarificationFor(["circularId", "titleContains"])
        };
      }
      return runTemplateOrClarify(
        deps,
        "circular_by_id_or_title",
        { circularId: slots.circularId, titleContains: slots.titleContains },
        ["circularId", "titleContains"]
      );
    }

    case "obligations_by_status": {
      const required: (keyof AssistantSlots)[] = ["status"];
      const missing = requireSlots(slots, required);
      if (missing.length > 0) {
        return { context: emptyAssistantGraphContext(), clarification: clarificationFor(missing) };
      }
      return runTemplateOrClarify(deps, "obligations_by_status", { status: slots.status }, required);
    }

    case "reviews_by_category_and_date_range": {
      const required: (keyof AssistantSlots)[] = ["categoryName", "dateFrom", "dateTo"];
      const missing = requireSlots(slots, required);
      if (missing.length > 0) {
        return { context: emptyAssistantGraphContext(), clarification: clarificationFor(missing) };
      }
      return runTemplateOrClarify(
        deps,
        "reviews_by_category_and_date_range",
        { categoryName: slots.categoryName, dateFrom: slots.dateFrom, dateTo: slots.dateTo, decision: slots.decision },
        required
      );
    }

    case "review_history_by_obligation": {
      const required: (keyof AssistantSlots)[] = ["obligationId"];
      const missing = requireSlots(slots, required);
      if (missing.length > 0) {
        return { context: emptyAssistantGraphContext(), clarification: clarificationFor(missing) };
      }
      const rows = await deps.auditQueryService.findByObligationId(slots.obligationId as string);
      return { context: await auditRowsToContext(rows, deps) };
    }

    case "review_history_by_circular": {
      const required: (keyof AssistantSlots)[] = ["circularId"];
      const missing = requireSlots(slots, required);
      if (missing.length > 0) {
        return { context: emptyAssistantGraphContext(), clarification: clarificationFor(missing) };
      }
      const response = await deps.auditQueryService.search({ circularId: slots.circularId as string });
      return { context: await auditRowsToContext(response.rows, deps) };
    }

    case "review_history_by_reviewer": {
      const required: (keyof AssistantSlots)[] = ["reviewerId"];
      const missing = requireSlots(slots, required);
      if (missing.length > 0) {
        return { context: emptyAssistantGraphContext(), clarification: clarificationFor(missing) };
      }
      const response = await deps.auditQueryService.search({
        reviewerId: slots.reviewerId as string,
        decidedFrom: slots.dateFrom ?? undefined,
        decidedTo: slots.dateTo ?? undefined,
        decision: slots.decision ?? undefined
      });
      return { context: await auditRowsToContext(response.rows, deps) };
    }

    default:
      throw new Error(
        `retrieveStructured() called with a non-structured intent: "${intent}" — the caller (index.ts) must route ` +
          "semantic_lookup/unsupported elsewhere before reaching here."
      );
  }
}
