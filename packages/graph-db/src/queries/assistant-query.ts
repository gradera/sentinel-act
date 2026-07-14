// AssistantQueryService — Spec 12 §5.2. The Conversational Assistant's
// structured (templated Cypher) retrieval path: looks up a named template
// from the fixed registry (assistant-query-templates.ts), validates the
// caller's params against that template's own zod schema, clamps `limit`
// to the template's `maxLimit` as a defense-in-depth belt alongside the
// schema's own cap (mirrors Spec 10 NFR-2's pageSize double-check
// pattern), and runs the query inside `session.executeRead` — never
// `executeWrite` (FR-21, NFR-2). This file MUST NOT import GraphWriter,
// commitProposal, or any repository create()/supersede() method (FR-22) —
// there is no such import below, and there must never be one added.
import type { Driver } from "neo4j-driver";
import { getAssistantSingletonDatabase } from "../readonly-driver.js";
import { ValidationError } from "../errors.js";
import { logOperation } from "../logger.js";
import { serializeProperties } from "../repositories/serialize.js";
import { findAssistantQueryTemplate } from "./assistant-query-templates.js";
import type { AssistantGraphContext } from "./assistant-query.types.js";

// §8 error-handling convention: an explicit transaction timeout, same
// precedent as AuditQueryService's SEARCH_TRANSACTION_TIMEOUT_MS
// (../audit-query.ts) — a runaway template query must not hang a chat
// request indefinitely.
const TEMPLATE_TRANSACTION_TIMEOUT_MS = 10_000;

// neo4j-driver's Record#get returns `any` throughout this package (see
// audit-query.ts's identical Neo4jRecord alias) — matched here rather
// than pulling in the full driver Record/Node generic typing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Neo4jRecord = any;

const OBLIGATION_NULLABLE_FIELDS = ["penalty_ref"] as const;
const HUMAN_REVIEW_NULLABLE_FIELDS = ["rationale"] as const;
// Circular/Clause/ProcessTask's Pick<> fields used by AssistantGraphContext
// (§4.1) contain no nullable members, so no backfill list is needed for
// those three.

function readNode(record: Neo4jRecord, key: string): Record<string, unknown> | null {
  const value = record.get(key);
  return value && value.properties ? (value.properties as Record<string, unknown>) : null;
}

function readNodeArray(record: Neo4jRecord, key: string): Record<string, unknown>[] {
  const value = record.get(key);
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is { properties: Record<string, unknown> } => Boolean(item?.properties))
    .map((item) => item.properties as Record<string, unknown>);
}

function pickCircular(properties: Record<string, unknown>): AssistantGraphContext["circulars"][number] {
  return serializeProperties(properties);
}

function pickClause(properties: Record<string, unknown>): AssistantGraphContext["clauses"][number] {
  return serializeProperties(properties);
}

function pickObligation(properties: Record<string, unknown>): AssistantGraphContext["obligations"][number] {
  return serializeProperties(properties, OBLIGATION_NULLABLE_FIELDS);
}

function pickProcessTask(properties: Record<string, unknown>): AssistantGraphContext["processTasks"][number] {
  return serializeProperties(properties);
}

function pickHumanReview(properties: Record<string, unknown>): AssistantGraphContext["humanReviews"][number] {
  return serializeProperties(properties, HUMAN_REVIEW_NULLABLE_FIELDS);
}

/** Accumulates rows from a template's result set into one deduplicated
 *  AssistantGraphContext — the same Circular/Clause/Obligation can appear
 *  on multiple rows (e.g. T1/T4's per-Obligation rows sharing a Circular),
 *  keyed by each entity's own id so it's represented exactly once. */
class ContextAccumulator {
  private readonly circulars = new Map<string, AssistantGraphContext["circulars"][number]>();
  private readonly clauses = new Map<string, AssistantGraphContext["clauses"][number]>();
  private readonly obligations = new Map<string, AssistantGraphContext["obligations"][number]>();
  private readonly processTasks = new Map<string, AssistantGraphContext["processTasks"][number]>();
  private readonly humanReviews = new Map<string, AssistantGraphContext["humanReviews"][number]>();

  addCircular(properties: Record<string, unknown> | null): void {
    if (!properties) return;
    const circular = pickCircular(properties);
    this.circulars.set(circular.circular_id, circular);
  }

  addClause(properties: Record<string, unknown> | null): void {
    if (!properties) return;
    const clause = pickClause(properties);
    this.clauses.set(clause.clause_id, clause);
  }

  addObligation(properties: Record<string, unknown> | null): void {
    if (!properties) return;
    const obligation = pickObligation(properties);
    this.obligations.set(obligation.obligation_id, obligation);
  }

  addProcessTask(properties: Record<string, unknown> | null): void {
    if (!properties) return;
    const task = pickProcessTask(properties);
    this.processTasks.set(task.task_id, task);
  }

  addHumanReview(properties: Record<string, unknown> | null): void {
    if (!properties) return;
    const review = pickHumanReview(properties);
    this.humanReviews.set(review.review_id, review);
  }

  toContext(): AssistantGraphContext {
    return {
      circulars: [...this.circulars.values()],
      clauses: [...this.clauses.values()],
      obligations: [...this.obligations.values()],
      processTasks: [...this.processTasks.values()],
      humanReviews: [...this.humanReviews.values()]
    };
  }
}

/** Maps one result record from a given template into the accumulator.
 *  Column names below are exactly the RETURN aliases each template in
 *  assistant-query-templates.ts declares — keep these two files in sync if
 *  either changes. */
function mapRecord(templateId: string, record: Neo4jRecord, acc: ContextAccumulator): void {
  switch (templateId) {
    case "obligations_by_category_and_date_range":
    case "obligations_by_status": {
      // RETURN o, cl, c
      acc.addObligation(readNode(record, "o"));
      acc.addClause(readNode(record, "cl"));
      acc.addCircular(readNode(record, "c"));
      return;
    }
    case "obligation_by_id_with_lineage": {
      // RETURN o, cl, c, collect(DISTINCT pt) AS tasks, collect(DISTINCT hr) AS reviews
      acc.addObligation(readNode(record, "o"));
      acc.addClause(readNode(record, "cl"));
      acc.addCircular(readNode(record, "c"));
      for (const task of readNodeArray(record, "tasks")) {
        acc.addProcessTask(task);
      }
      for (const review of readNodeArray(record, "reviews")) {
        acc.addHumanReview(review);
      }
      return;
    }
    case "circular_by_id_or_title": {
      // RETURN c, collect(DISTINCT cl) AS clauses, collect(DISTINCT o) AS obligations
      acc.addCircular(readNode(record, "c"));
      for (const clause of readNodeArray(record, "clauses")) {
        acc.addClause(clause);
      }
      for (const obligation of readNodeArray(record, "obligations")) {
        acc.addObligation(obligation);
      }
      return;
    }
    case "reviews_by_category_and_date_range": {
      // RETURN o, hr, cl, c
      acc.addObligation(readNode(record, "o"));
      acc.addHumanReview(readNode(record, "hr"));
      acc.addClause(readNode(record, "cl"));
      acc.addCircular(readNode(record, "c"));
      return;
    }
    default:
      // Unreachable given findAssistantQueryTemplate already validated
      // templateId against the fixed registry before this is called.
      throw new ValidationError(`No row mapper registered for assistant query template id: "${templateId}".`);
  }
}

export class AssistantQueryService {
  constructor(private readonly driver: Driver) {}

  private openSession() {
    return this.driver.session({ database: getAssistantSingletonDatabase() });
  }

  /** Looks up the named template, validates `rawParams` against its own
   *  zod schema (rejecting — not silently coercing — anything that fails,
   *  FR-5), clamps `limit` to `template.maxLimit` as a second, redundant
   *  guard beyond the schema's own cap (FR-8), and runs it inside
   *  `session.executeRead` — never `executeWrite` (FR-21, NFR-2). Throws
   *  ValidationError if params don't satisfy the template's schema or if
   *  `templateId` isn't one of the five registered templates; the caller
   *  (structured-retrieval.ts) turns this into a clarification response,
   *  never a 500. */
  async runTemplate(templateId: string, rawParams: Record<string, unknown>): Promise<AssistantGraphContext> {
    const start = Date.now();
    const template = findAssistantQueryTemplate(templateId);
    if (!template) {
      throw new ValidationError(`Unknown assistant query template id: "${templateId}".`);
    }

    const parseResult = template.paramsSchema.safeParse(rawParams);
    if (!parseResult.success) {
      throw new ValidationError(
        `Params for assistant query template "${templateId}" failed validation.`,
        parseResult.error.issues
      );
    }

    const params = { ...(parseResult.data as Record<string, unknown>) };
    if ("limit" in params) {
      const requested = typeof params.limit === "number" ? params.limit : template.defaultLimit;
      params.limit = Math.min(Math.max(requested, 1), template.maxLimit);
    }

    const session = this.openSession();
    try {
      const context = await session.executeRead(
        async (tx) => {
          const result = await tx.run(template.cypher, params);
          const acc = new ContextAccumulator();
          for (const record of result.records) {
            mapRecord(templateId, record, acc);
          }
          return acc.toContext();
        },
        { timeout: TEMPLATE_TRANSACTION_TIMEOUT_MS }
      );
      logOperation({
        operation: "runTemplate",
        label: templateId,
        durationMs: Date.now() - start,
        outcome: "success",
        detail: {
          obligationCount: context.obligations.length,
          clauseCount: context.clauses.length,
          circularCount: context.circulars.length,
          processTaskCount: context.processTasks.length,
          humanReviewCount: context.humanReviews.length
        }
      });
      return context;
    } catch (error) {
      logOperation({ operation: "runTemplate", label: templateId, durationMs: Date.now() - start, outcome: "error" });
      throw error;
    } finally {
      await session.close();
    }
  }
}
