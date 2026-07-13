// AuditQueryService — Spec 10 §5.2. The Compliance Head/auditor's ONLY
// read path into HumanReview facts: apps/web-console's audit route
// handlers call this and nothing else (FR-1's docstring). Every method
// here is read-only (`session.executeRead`, never `executeWrite` — NFR-4,
// FR-21) and this file MUST NOT import GraphWriter, commitProposal, or any
// repository create()/supersede() method (FR-21) — there is no such
// import below, and there must never be one added.
//
// ***** FR-11a — read this before touching any Cypher in this file *****
//
// A Tier C Obligation's maker HumanReview is written to the graph the
// moment the maker submits, before the checker acts (Spec 07
// recordHumanReview). Spec 09's checker-facing screen redacts this via
// getReviewsVisibleTo; this unit has no per-caller redaction concept
// (nobody using Observer mode is one of the two reviewers), so instead it
// unconditionally excludes an unresolved Tier C maker decision from every
// read path here. Spec 10 §4.3/§4.4 give the guard as:
//
//   AND NOT (hr.tier = "C" AND o.status = "tier_c_review")
//
// This implementation WIDENS that condition to also cover
// `o.status = "escalated"`. This is a deliberate, evidence-backed
// deviation from the spec's literal Cypher text, not an oversight — see
// FR_11A_GUARD's doc comment below for the full trail.

import type { Driver } from "neo4j-driver";
import type { Circular, Clause, HumanReview, Obligation, ProcessTask, ReviewTier } from "@sentinel-act/graph-schema";
import { getSingletonDatabase } from "../driver.js";
import { ValidationError } from "../errors.js";
import { logOperation } from "../logger.js";
import { pointInTimeWhereClause } from "../point-in-time.js";
import { serializeProperties } from "../repositories/serialize.js";
import type { AuditQueryFilters, AuditQueryResponse, AuditTrailRow, RegisterQueryRow } from "./audit-query.types.js";

/**
 * Why "escalated" had to be added to the spec's literal `o.status =
 * "tier_c_review"` guard, verified against the real cross-spec
 * implementation (not assumed):
 *
 * 1. `ObligationStatus` (graph-schema/src/nodes.ts) has `"tier_c_review"`
 *    and `"escalated"` as two DISTINCT values. Spec 08's own status
 *    mapping (apps/orchestrator/src/mastra/workflows/orchestrator.logic.ts,
 *    `preReviewStatusForTier`) sets a Tier C item's pre-review status to
 *    `"tier_c_review"` and an ESCALATE item's to `"escalated"` — never the
 *    same value. Spec 09's own `apps/web-console/lib/console/
 *    obligation-tier.ts` (`STATUS_TO_TIER`) independently confirms this
 *    1:1 status<->tier mapping.
 * 2. `requiresSecondReview(tier)` (orchestrator.logic.ts) returns `true`
 *    for BOTH `"C"` and `"ESCALATE"` — an ESCALATE item goes through the
 *    exact same maker-then-checker suspend/claim mechanics as Tier C
 *    (confirmed by `deriveReviewGateView`'s "Tier C / ESCALATE — dual
 *    review" branch treating both identically), which means an ESCALATE
 *    item's maker HumanReview is ALSO written to the graph before its
 *    checker acts — the identical independence window FR-11a exists to
 *    close.
 * 3. `HumanReview.tier` (graph-schema) has no `"ESCALATE"` value at all —
 *    `ReviewTier = "A" | "B" | "C"`. Spec 09's own decision route
 *    (apps/web-console/app/api/console/items/[obligationId]/decisions/
 *    route.ts, `humanReviewTierFor`) documents and implements the
 *    substitution: an ESCALATE item's HumanReview is persisted with
 *    `tier: "C"` on the wire, since "C" is the closest real ReviewTier
 *    value for a dual-independent-review decision.
 *
 * Putting 1-3 together: an ESCALATE item's in-progress maker HumanReview
 * is indistinguishable from a genuine Tier C item's by `hr.tier` alone
 * (both are persisted as `"C"`) — the only thing that tells them apart is
 * `Obligation.status`, which is `"escalated"` for the former and
 * `"tier_c_review"` for the latter. A guard that only checks
 * `o.status = "tier_c_review"` therefore leaves the ESCALATE item's
 * unresolved maker decision fully exposed through this exact same side
 * door FR-11a was written to close — the spec's own prose ("Tier B/
 * ESCALATE/A have no analogous independence window and are unaffected")
 * does not hold up against the real Spec 08/09 implementation for
 * ESCALATE specifically (it does hold for Tier B and Tier A, which have
 * no comparable dual-review window). This file widens the guard to
 * `o.status IN ["tier_c_review", "escalated"]` to actually close the gap;
 * flagged here in detail so a future reader does not "fix" this back to
 * the spec's literal text without re-deriving the same finding.
 */
const FR_11A_GUARD = 'NOT (hr.tier = "C" AND o.status IN ["tier_c_review", "escalated"])';

// §8 error-handling table: "AuditQueryService.search/findRegisterAsOf set
// an explicit Neo4j transaction timeout (10s search, 60s export
// generation query) matching Spec 01's graph-writer.ts pattern."
const SEARCH_TRANSACTION_TIMEOUT_MS = 10_000;
const REGISTER_TRANSACTION_TIMEOUT_MS = 60_000;

// NFR-2: pageSize capped at 200 regardless of what a caller requests; the
// Test Plan (§10) additionally requires this unit reject (not silently
// clamp) an out-of-bound pageSize before opening a session, as a
// defense-in-depth belt alongside the route handler's own zod validation
// (§8's 400 { error, field } path).
const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;

// The two OPTIONAL MATCH lineage/task hops shared verbatim by search(),
// findByReviewId(), and findByObligationId() (§4.3).
const LINEAGE_OPTIONAL_MATCHES = `OPTIONAL MATCH (o)-[:DERIVED_FROM]->(cl:Clause)-[:PART_OF]->(c:Circular)
OPTIONAL MATCH (o)-[:MAPPED_TO]->(pt:ProcessTask)`;

interface SearchParams {
  obligationId: string | null;
  circularId: string | null;
  reviewerId: string | null;
  freeText: string | null;
  tier: ReviewTier | null;
  decision: string | null;
  decidedFrom: string | null;
  decidedTo: string | null;
}

function toSearchParams(filters: AuditQueryFilters): SearchParams {
  return {
    obligationId: filters.obligationId ?? null,
    circularId: filters.circularId ?? null,
    reviewerId: filters.reviewerId ?? null,
    freeText: filters.freeText ?? null,
    tier: filters.tier ?? null,
    decision: filters.decision ?? null,
    decidedFrom: filters.decidedFrom ?? null,
    decidedTo: filters.decidedTo ?? null
  };
}

/** §4.3's exact filter-predicate AND-list, as parameterized Cypher — no
 *  string interpolation of any request-derived value (NFR-3). Shared by
 *  the paged search query and its identically-filtered count query so the
 *  two can never drift out of sync. */
const SEARCH_FILTER_PREDICATES = `($obligationId IS NULL OR o.obligation_id = $obligationId)
  AND ($circularId   IS NULL OR c.circular_id   = $circularId)
  AND ($reviewerId   IS NULL OR toLower(hr.reviewer_id) CONTAINS toLower($reviewerId))
  AND ($tier         IS NULL OR hr.tier     = $tier)
  AND ($decision     IS NULL OR hr.decision = $decision)
  AND ($decidedFrom  IS NULL OR hr.decided_at >= datetime($decidedFrom))
  AND ($decidedTo    IS NULL OR hr.decided_at <= datetime($decidedTo))
  AND ($freeText IS NULL OR
       toLower(o.requirement_text) CONTAINS toLower($freeText) OR
       toLower(c.title)            CONTAINS toLower($freeText) OR
       toLower(cl.para_ref)        CONTAINS toLower($freeText))
  AND ${FR_11A_GUARD}`;

// ---------------------------------------------------------------------------
// Node -> domain-type deserialization. Mirrors each repository's own
// nullableFields list (see base.repository.ts's doc comment for why this
// backfill exists) — duplicated here rather than instantiating a
// repository purely to read a protected getter, same precedent as
// repositories/circular-lookups.ts's CIRCULAR_NULLABLE_FIELDS.
// ---------------------------------------------------------------------------

const OBLIGATION_NULLABLE_FIELDS = ["valid_to", "penalty_ref"] as const;
const CIRCULAR_NULLABLE_FIELDS = ["valid_to", "supersedes_circular_id"] as const;
const CLAUSE_NULLABLE_FIELDS = ["valid_to"] as const;
const PROCESS_TASK_NULLABLE_FIELDS = ["valid_to"] as const;
const HUMAN_REVIEW_NULLABLE_FIELDS = ["valid_to", "rationale"] as const;

function deserializeObligation(properties: Record<string, unknown>): Obligation {
  return serializeProperties<Obligation>(properties, OBLIGATION_NULLABLE_FIELDS);
}

function deserializeCircular(properties: Record<string, unknown>): Pick<Circular, "circular_id" | "title" | "date_issued" | "date_effective"> {
  const circular = serializeProperties<Circular>(properties, CIRCULAR_NULLABLE_FIELDS);
  return {
    circular_id: circular.circular_id,
    title: circular.title,
    date_issued: circular.date_issued,
    date_effective: circular.date_effective
  };
}

function deserializeClause(properties: Record<string, unknown>): Pick<Clause, "clause_id" | "para_ref"> {
  const clause = serializeProperties<Clause>(properties, CLAUSE_NULLABLE_FIELDS);
  return { clause_id: clause.clause_id, para_ref: clause.para_ref };
}

function deserializeProcessTaskForTrail(properties: Record<string, unknown>): Pick<ProcessTask, "task_id" | "task_name" | "risk_score"> {
  const task = serializeProperties<ProcessTask>(properties, PROCESS_TASK_NULLABLE_FIELDS);
  return { task_id: task.task_id, task_name: task.task_name, risk_score: task.risk_score };
}

function deserializeProcessTaskForRegister(
  properties: Record<string, unknown>
): Pick<ProcessTask, "task_id" | "task_name" | "owner_role" | "sla_hours" | "system_touchpoint" | "risk_score"> {
  const task = serializeProperties<ProcessTask>(properties, PROCESS_TASK_NULLABLE_FIELDS);
  return {
    task_id: task.task_id,
    task_name: task.task_name,
    owner_role: task.owner_role,
    sla_hours: task.sla_hours,
    system_touchpoint: task.system_touchpoint,
    risk_score: task.risk_score
  };
}

function deserializeHumanReview(properties: Record<string, unknown>): HumanReview {
  return serializeProperties<HumanReview>(properties, HUMAN_REVIEW_NULLABLE_FIELDS);
}

// neo4j-driver's Record#get returns `any` for every repository in this
// package (see obligation.repository.ts etc.) — matched here rather than
// pulling in the full driver Record/Node generic typing, which none of
// the existing repositories bother with either.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Neo4jRecord = any;

function mapRecordToAuditTrailRow(record: Neo4jRecord): AuditTrailRow {
  const obligation = deserializeObligation(record.get("o").properties);
  const review = deserializeHumanReview(record.get("hr").properties);
  const clauseNode = record.get("cl");
  const circularNode = record.get("c");
  const taskNodes: Neo4jRecord[] = record.get("tasks") ?? [];

  return {
    review,
    obligation: {
      obligation_id: obligation.obligation_id,
      category: obligation.category,
      requirement_text: obligation.requirement_text,
      status: obligation.status,
      confidence_score: obligation.confidence_score,
      grounding_score: obligation.grounding_score,
      penalty_ref: obligation.penalty_ref
    },
    clause: clauseNode ? deserializeClause(clauseNode.properties) : null,
    circular: circularNode ? deserializeCircular(circularNode.properties) : null,
    processTasks: taskNodes.map((node) => deserializeProcessTaskForTrail(node.properties))
  };
}

export class AuditQueryService {
  constructor(private readonly driver: Driver) {}

  private openSession() {
    return this.driver.session({ database: getSingletonDatabase() });
  }

  /** Executes the §4.3 Cypher shape (with the FR-11a guard widened per
   *  this file's top-of-file doc comment). Read-only: opens
   *  session.executeRead, never executeWrite. This is the ONLY method
   *  apps/web-console's audit route handlers call for the search screen. */
  async search(filters: AuditQueryFilters): Promise<AuditQueryResponse> {
    const start = Date.now();
    const page = filters.page ?? DEFAULT_PAGE;
    const pageSize = filters.pageSize ?? DEFAULT_PAGE_SIZE;

    // Test Plan (§10): "pageSize > 200 is rejected before a session is
    // opened" — defense in depth alongside the route handler's own zod
    // 400 validation (§8).
    if (pageSize > MAX_PAGE_SIZE) {
      throw new ValidationError(`pageSize (${pageSize}) exceeds the maximum of ${MAX_PAGE_SIZE}.`);
    }
    if (page < 1) {
      throw new ValidationError(`page (${page}) must be >= 1.`);
    }

    const skip = (page - 1) * pageSize;
    const params = {
      ...toSearchParams(filters),
      skip,
      limit: pageSize
    };

    const pageCypher = `MATCH (o:Obligation)-[:REVIEWED_BY]->(hr:HumanReview)
${LINEAGE_OPTIONAL_MATCHES}
WHERE ${SEARCH_FILTER_PREDICATES}
WITH o, hr, cl, c, collect(DISTINCT pt) AS tasks
ORDER BY hr.decided_at DESC
SKIP $skip LIMIT $limit
RETURN o, hr, cl, c, tasks`;

    // Same filter predicates, no SKIP/LIMIT, no ProcessTask join (not
    // referenced by any predicate) — §4.3: "run in the same read
    // transaction ... so the count and the page are consistent with each
    // other even under concurrent graph writes."
    const countCypher = `MATCH (o:Obligation)-[:REVIEWED_BY]->(hr:HumanReview)
OPTIONAL MATCH (o)-[:DERIVED_FROM]->(cl:Clause)-[:PART_OF]->(c:Circular)
WHERE ${SEARCH_FILTER_PREDICATES}
RETURN count(DISTINCT hr) AS total`;

    const session = this.openSession();
    try {
      const { rows, totalCount } = await session.executeRead(
        async (tx) => {
          const pageResult = await tx.run(pageCypher, params);
          const countResult = await tx.run(countCypher, toSearchParams(filters));
          const total = countResult.records[0]?.get("total");
          return {
            rows: pageResult.records.map(mapRecordToAuditTrailRow),
            totalCount: typeof total === "number" ? total : Number(total?.toNumber?.() ?? total ?? 0)
          };
        },
        { timeout: SEARCH_TRANSACTION_TIMEOUT_MS }
      );
      logOperation({ operation: "search", label: "HumanReview", durationMs: Date.now() - start, outcome: "success", detail: { rowCount: rows.length } });
      return { rows, totalCount, page, pageSize };
    } catch (error) {
      logOperation({ operation: "search", label: "HumanReview", durationMs: Date.now() - start, outcome: "error" });
      throw error;
    } finally {
      await session.close();
    }
  }

  /** Single-row lookup by HumanReview.review_id, full lineage attached —
   *  backs GET /api/audit/reviews/:reviewId (row drill-in / deep link).
   *  Applies the same FR-11a guard: an in-progress Tier C/ESCALATE maker
   *  decision looked up directly by its review_id must not be revealed
   *  here either — the route handler surfaces this as 404, matching
   *  FR-10's "unknown review_id" behavior (an auditor cannot distinguish
   *  "does not exist" from "exists but is not yet visible to you", which
   *  is the correct behavior for this surface). */
  async findByReviewId(reviewId: string): Promise<AuditTrailRow | null> {
    const start = Date.now();
    const cypher = `MATCH (o:Obligation)-[:REVIEWED_BY]->(hr:HumanReview {review_id: $reviewId})
${LINEAGE_OPTIONAL_MATCHES}
WHERE ${FR_11A_GUARD}
WITH o, hr, cl, c, collect(DISTINCT pt) AS tasks
RETURN o, hr, cl, c, tasks`;

    const session = this.openSession();
    try {
      const result = await session.executeRead((tx) => tx.run(cypher, { reviewId }), { timeout: SEARCH_TRANSACTION_TIMEOUT_MS });
      const record = result.records[0];
      const value = record ? mapRecordToAuditTrailRow(record) : null;
      logOperation({ operation: "findByReviewId", label: "HumanReview", durationMs: Date.now() - start, outcome: "success" });
      return value;
    } catch (error) {
      logOperation({ operation: "findByReviewId", label: "HumanReview", durationMs: Date.now() - start, outcome: "error" });
      throw error;
    } finally {
      await session.close();
    }
  }

  /** All HumanReview rows for one Obligation, ordered by decided_at asc —
   *  used to render the maker+checker pair together for a Tier C item
   *  (FR-7). Returns 0, 1, or 2 rows (2 only for a resolved Tier C item);
   *  an unresolved Tier C/ESCALATE item's lone maker review is excluded by
   *  the FR-11a guard, so it correctly returns 0 rows until resolution. */
  async findByObligationId(obligationId: string): Promise<AuditTrailRow[]> {
    const start = Date.now();
    const cypher = `MATCH (o:Obligation {obligation_id: $obligationId})-[:REVIEWED_BY]->(hr:HumanReview)
${LINEAGE_OPTIONAL_MATCHES}
WHERE ${FR_11A_GUARD}
WITH o, hr, cl, c, collect(DISTINCT pt) AS tasks
ORDER BY hr.decided_at ASC
RETURN o, hr, cl, c, tasks`;

    const session = this.openSession();
    try {
      const result = await session.executeRead((tx) => tx.run(cypher, { obligationId }), { timeout: SEARCH_TRANSACTION_TIMEOUT_MS });
      const rows = result.records.map(mapRecordToAuditTrailRow);
      logOperation({ operation: "findByObligationId", label: "HumanReview", durationMs: Date.now() - start, outcome: "success", detail: { rowCount: rows.length } });
      return rows;
    } catch (error) {
      logOperation({ operation: "findByObligationId", label: "HumanReview", durationMs: Date.now() - start, outcome: "error" });
      throw error;
    } finally {
      await session.close();
    }
  }

  /** The §4.4 point-in-time query, producing raw rows the report
   *  generators (packages/report-generation) flatten via
   *  to-register-rows.ts. Read-only. Reuses pointInTimeWhereClause (Spec
   *  01) rather than reimplementing valid-time predicate logic. The
   *  FR-11a guard sits inside the `OPTIONAL MATCH (o)-[:REVIEWED_BY]->(hr)`
   *  clause's OWN WHERE — not the outer query WHERE — so an Obligation row
   *  still comes through (with `hr` unmatched for an in-progress Tier
   *  C/ESCALATE review) rather than being dropped entirely; a resolved
   *  obligation's real HumanReview rows still populate normally. */
  async findRegisterAsOf(request: {
    asOfDate: string;
    category?: string;
    intermediaryCategoryName?: string;
    tier?: ReviewTier;
  }): Promise<RegisterQueryRow[]> {
    const start = Date.now();
    const params = {
      asOfDate: request.asOfDate,
      category: request.category ?? null,
      intermediaryCategoryName: request.intermediaryCategoryName ?? null,
      tier: request.tier ?? null
    };

    const cypher = `MATCH (o:Obligation)
WHERE ${pointInTimeWhereClause("o", "asOfDate")}
  AND ($category IS NULL OR o.category = $category)
OPTIONAL MATCH (o)-[:DERIVED_FROM]->(cl:Clause)-[:PART_OF]->(c:Circular)
OPTIONAL MATCH (o)-[:MAPPED_TO]->(pt:ProcessTask)
OPTIONAL MATCH (o)-[:REVIEWED_BY]->(hr:HumanReview)
  WHERE ($tier IS NULL OR hr.tier = $tier)
  AND ${FR_11A_GUARD}
OPTIONAL MATCH (o)-[:APPLIES_TO]->(ic:IntermediaryCategory)
  WHERE ($intermediaryCategoryName IS NULL OR ic.name = $intermediaryCategoryName)
WITH o, cl, c, collect(DISTINCT pt) AS tasks, collect(DISTINCT hr) AS reviews, collect(DISTINCT ic) AS categories
WHERE ($intermediaryCategoryName IS NULL OR size(categories) > 0)
RETURN o, cl, c, tasks, reviews
ORDER BY o.category, o.obligation_id`;

    const session = this.openSession();
    try {
      const result = await session.executeRead((tx) => tx.run(cypher, params), { timeout: REGISTER_TRANSACTION_TIMEOUT_MS });
      const rows: RegisterQueryRow[] = result.records.map((record: Neo4jRecord) => {
        const obligation = deserializeObligation(record.get("o").properties);
        const clauseNode = record.get("cl");
        const circularNode = record.get("c");
        const taskNodes: Neo4jRecord[] = record.get("tasks") ?? [];
        const reviewNodes: Neo4jRecord[] = record.get("reviews") ?? [];
        return {
          obligation,
          clause: clauseNode ? deserializeClause(clauseNode.properties) : null,
          circular: circularNode ? deserializeCircular(circularNode.properties) : null,
          tasks: taskNodes.map((node) => deserializeProcessTaskForRegister(node.properties)),
          reviews: reviewNodes.map((node) => deserializeHumanReview(node.properties))
        };
      });
      logOperation({ operation: "findRegisterAsOf", label: "Obligation", durationMs: Date.now() - start, outcome: "success", detail: { rowCount: rows.length } });
      return rows;
    } catch (error) {
      logOperation({ operation: "findRegisterAsOf", label: "Obligation", durationMs: Date.now() - start, outcome: "error" });
      throw error;
    } finally {
      await session.close();
    }
  }

  /**
   * Spec 10 §5.5/FR-12 — "estimate the row count for a requested export
   * (via a count(*)-shaped variant of the §4.4 query, before generating
   * anything)". Added this stage (not in the original §5.2 signature):
   * `findRegisterAsOf` alone hydrates full Obligation/Clause/Circular/
   * ProcessTask/HumanReview node properties for every row, which is
   * exactly the cost FR-12 wants to avoid paying before deciding
   * sync-vs-async. This method mirrors the SAME point-in-time predicate
   * and FR-11a guard placement as `findRegisterAsOf` (§4.4), but computes
   * only a `count(DISTINCT ...)` aggregate — no node property maps are
   * read at all, only relationship-count aggregates — so it is
   * meaningfully cheaper for the same request.
   *
   * The returned number matches the row count `packages/report-generation`'s
   * `toRegisterRows` would actually produce for the identical request: it
   * reproduces that module's FR-15 cross-product rule (one row per
   * (ProcessTask, HumanReview) pair, each dimension defaulting to exactly
   * one synthetic slot when the Obligation has zero matches in it) via
   * `count(DISTINCT pt)`/`count(DISTINCT hr)` per Obligation, multiplied
   * together (each floored at 1), then summed across Obligations. If
   * `to-register-rows.ts`'s "default to one synthetic slot when empty"
   * rule ever changes, this query's CASE expressions must change with it
   * or the two will silently drift apart.
   */
  async countRegisterAsOf(request: {
    asOfDate: string;
    category?: string;
    intermediaryCategoryName?: string;
    tier?: ReviewTier;
  }): Promise<number> {
    const start = Date.now();
    const params = {
      asOfDate: request.asOfDate,
      category: request.category ?? null,
      intermediaryCategoryName: request.intermediaryCategoryName ?? null,
      tier: request.tier ?? null
    };

    const cypher = `MATCH (o:Obligation)
WHERE ${pointInTimeWhereClause("o", "asOfDate")}
  AND ($category IS NULL OR o.category = $category)
OPTIONAL MATCH (o)-[:MAPPED_TO]->(pt:ProcessTask)
OPTIONAL MATCH (o)-[:REVIEWED_BY]->(hr:HumanReview)
  WHERE ($tier IS NULL OR hr.tier = $tier)
  AND ${FR_11A_GUARD}
OPTIONAL MATCH (o)-[:APPLIES_TO]->(ic:IntermediaryCategory)
  WHERE ($intermediaryCategoryName IS NULL OR ic.name = $intermediaryCategoryName)
WITH o, count(DISTINCT pt) AS taskCount, count(DISTINCT hr) AS reviewCount, collect(DISTINCT ic) AS categories
WHERE ($intermediaryCategoryName IS NULL OR size(categories) > 0)
RETURN sum(
  (CASE WHEN taskCount = 0 THEN 1 ELSE taskCount END) *
  (CASE WHEN reviewCount = 0 THEN 1 ELSE reviewCount END)
) AS total`;

    const session = this.openSession();
    try {
      const result = await session.executeRead((tx) => tx.run(cypher, params), { timeout: REGISTER_TRANSACTION_TIMEOUT_MS });
      const total = result.records[0]?.get("total");
      // sum() over zero matching rows returns Cypher `null`, not 0 — the
      // same `?? 0` fallback chain search()/countActiveJobs() already use.
      const count = typeof total === "number" ? total : Number(total?.toNumber?.() ?? total ?? 0);
      logOperation({ operation: "countRegisterAsOf", label: "Obligation", durationMs: Date.now() - start, outcome: "success", detail: { count } });
      return count;
    } catch (error) {
      logOperation({ operation: "countRegisterAsOf", label: "Obligation", durationMs: Date.now() - start, outcome: "error" });
      throw error;
    } finally {
      await session.close();
    }
  }
}
