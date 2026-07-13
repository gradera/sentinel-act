// audit-query.test.ts (Spec 10 §10) — mocked neo4j-driver session/
// transaction, per this package's established unit-test convention (see
// test/repositories/obligation.repository.test.ts).
//
// ***** Honesty note on what this file can and cannot prove *****
// A mocked-driver unit test proves the Cypher *string* AuditQueryService
// sends to `session.run`/`tx.run` is well-formed and contains the FR-11a
// guard in the right clause, for each of search()/findByReviewId()/
// findByObligationId()/findRegisterAsOf(). It CANNOT prove the guard
// actually filters correctly against a real running Neo4j instance — in
// particular, findRegisterAsOf's `OPTIONAL MATCH ... WHERE` placement
// subtlety (an unmatched `hr` must not drop the whole `Obligation` row)
// needs real graph state to verify end to end, since the mock driver
// never evaluates Cypher semantics, it only records what string/params
// were passed to `.run()` and returns whatever canned records the test
// supplies. This sandbox has no docker/podman binary and no docker
// socket (confirmed), so `packages/graph-db`'s existing
// `test/integration/*.integration.test.ts` (testcontainers) pattern
// cannot be exercised here even though the devDependency is already
// present. A real `test/integration/audit-search.integration.test.ts`,
// following that existing pattern and covering Acceptance Criteria 1, 2,
// 2a, 3, 6 (§9) against a live Neo4j 5.13+ container, is still required
// before this unit is genuinely done per the spec's own Definition of
// Done (§12) — flagged here explicitly, not skipped silently.
import { describe, expect, it } from "vitest";
import { AuditQueryService } from "../../src/queries/audit-query.js";
import { ValidationError } from "../../src/errors.js";
import { createMockDriver, mockRecord } from "../helpers/mock-driver.js";

const FR_11A_GUARD_STRING = 'NOT (hr.tier = "C" AND o.status IN ["tier_c_review", "escalated"])';

/** Collapses runs of whitespace to a single space so assertions against
 *  the hand-aligned (padded-for-readability) predicate list in
 *  audit-query.ts's SEARCH_FILTER_PREDICATES don't depend on exact
 *  column-alignment spacing — only on the logical Cypher content. */
function normalizeWhitespace(cypher: string): string {
  return cypher.replace(/\s+/g, " ").trim();
}

const baseObligationProps = {
  obligation_id: "ob-1",
  derived_from_clause_id: "cl-1",
  category: "disclosure",
  requirement_text: "req text",
  trigger_event: "trigger",
  deadline_rule: "T+5",
  responsible_role: "Compliance Officer",
  evidence_required: "log",
  penalty_ref: null,
  confidence_score: 0.9,
  grounding_score: 0.9,
  status: "committed",
  valid_from: "2026-01-01",
  valid_to: null,
  recorded_at: "2026-01-01T00:00:00Z"
};

const baseReviewProps = {
  review_id: "rev-1",
  obligation_id: "ob-1",
  reviewer_id: "alice@example.com",
  tier: "B",
  decision: "approve",
  rationale: null,
  decided_at: "2026-01-05T00:00:00Z",
  valid_from: "2026-01-05",
  valid_to: null,
  recorded_at: "2026-01-05T00:00:00Z"
};

const baseClauseProps = { clause_id: "cl-1", circular_id: "circ-1", para_ref: "46", text: "t", embedding_ref: "[]", valid_from: "2026-01-01", valid_to: null, recorded_at: "2026-01-01T00:00:00Z" };
const baseCircularProps = {
  circular_id: "circ-1",
  title: "Sample Circular",
  type: "circular",
  category: "disclosure",
  date_issued: "2025-12-01",
  date_effective: "2026-01-01",
  source_hash: "hash",
  supersedes_circular_id: null,
  valid_from: "2025-12-01",
  valid_to: null,
  recorded_at: "2025-12-01T00:00:00Z"
};

function fullSearchRecord() {
  return mockRecord({
    o: { properties: baseObligationProps },
    hr: { properties: baseReviewProps },
    cl: { properties: baseClauseProps },
    c: { properties: baseCircularProps },
    tasks: []
  });
}

describe("AuditQueryService.search", () => {
  // FR-1: every AuditQueryFilters field is combinable — each predicate
  // below is unconditionally present in the WHERE clause, gated only by
  // its own `$x IS NULL OR ...` guard, so supplying several filters at
  // once ANDs them together mechanically (there is no per-combination
  // branch to test separately; the individual "wires X through" tests
  // below prove each filter's own parameter wiring).
  // FR-8: default sort is `ORDER BY hr.decided_at DESC` (most recent
  // decision first) — asserted below via `pageCall.cypher`.
  it("builds the §4.3 Cypher shape with every filter defaulted to null and includes the FR-11a guard", async () => {
    const { driver, calls } = createMockDriver((cypher) => {
      if (cypher.includes("count(DISTINCT hr)")) {
        return { records: [mockRecord({ total: 0 })] };
      }
      return { records: [] };
    });
    const service = new AuditQueryService(driver);

    const response = await service.search({});

    expect(calls).toHaveLength(2);
    const pageCall = calls[0];
    const countCall = calls[1];

    // Predicate shape, verbatim from §4.3 (whitespace-normalized so the
    // assertion depends only on logical Cypher content, not the source's
    // hand-aligned column padding).
    for (const call of [pageCall, countCall]) {
      const normalized = normalizeWhitespace(call.cypher);
      expect(normalized).toContain("($obligationId IS NULL OR o.obligation_id = $obligationId)");
      expect(normalized).toContain("($circularId IS NULL OR c.circular_id = $circularId)");
      expect(normalized).toContain("toLower(hr.reviewer_id) CONTAINS toLower($reviewerId)");
      expect(normalized).toContain("($tier IS NULL OR hr.tier = $tier)");
      expect(normalized).toContain("($decision IS NULL OR hr.decision = $decision)");
      expect(normalized).toContain("hr.decided_at >= datetime($decidedFrom)");
      expect(normalized).toContain("hr.decided_at <= datetime($decidedTo)");
      expect(normalized).toContain("toLower(o.requirement_text) CONTAINS toLower($freeText)");
      expect(normalized).toContain("toLower(c.title) CONTAINS toLower($freeText)");
      expect(normalized).toContain("toLower(cl.para_ref) CONTAINS toLower($freeText)");
      // ***** FR-11a — the load-bearing assertion in this whole file *****
      expect(call.cypher).toContain(FR_11A_GUARD_STRING);
    }

    expect(pageCall.cypher).toContain("MATCH (o:Obligation)-[:REVIEWED_BY]->(hr:HumanReview)");
    expect(pageCall.cypher).toContain("OPTIONAL MATCH (o)-[:DERIVED_FROM]->(cl:Clause)-[:PART_OF]->(c:Circular)");
    expect(pageCall.cypher).toContain("OPTIONAL MATCH (o)-[:MAPPED_TO]->(pt:ProcessTask)");
    expect(pageCall.cypher).toContain("collect(DISTINCT pt) AS tasks");
    expect(pageCall.cypher).toContain("ORDER BY hr.decided_at DESC");
    expect(pageCall.cypher).toContain("SKIP $skip LIMIT $limit");
    expect(pageCall.cypher).toContain("RETURN o, hr, cl, c, tasks");

    // Count query: same predicates, no SKIP/LIMIT, no ProcessTask join.
    expect(countCall.cypher).toContain("RETURN count(DISTINCT hr) AS total");
    expect(countCall.cypher).not.toContain("SKIP");
    expect(countCall.cypher).not.toContain("MAPPED_TO");

    // All filters default to null.
    expect(pageCall.params.obligationId).toBeNull();
    expect(pageCall.params.circularId).toBeNull();
    expect(pageCall.params.reviewerId).toBeNull();
    expect(pageCall.params.tier).toBeNull();
    expect(pageCall.params.decision).toBeNull();
    expect(pageCall.params.decidedFrom).toBeNull();
    expect(pageCall.params.decidedTo).toBeNull();
    expect(pageCall.params.freeText).toBeNull();

    // Default pagination: page 1, pageSize 50 -> skip 0, limit 50.
    expect(pageCall.params.skip).toBe(0);
    expect(pageCall.params.limit).toBe(50);
    expect(response.page).toBe(1);
    expect(response.pageSize).toBe(50);
    expect(response.totalCount).toBe(0);
    expect(response.rows).toEqual([]);
  });

  // FR-9: totalCount MUST be computed in the same read transaction as the
  // page of rows (one session.executeRead, not two separate connections
  // that could race a concurrent write between them).
  it("both the page query and the count query run inside the same read transaction (one session opened)", async () => {
    const { driver, sessionCallCount, calls } = createMockDriver((cypher) =>
      cypher.includes("count(DISTINCT hr)") ? { records: [mockRecord({ total: 1 })] } : { records: [fullSearchRecord()] }
    );
    const service = new AuditQueryService(driver);

    await service.search({});

    expect(sessionCallCount()).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it("wires obligationId through as a literal parameter", async () => {
    const { driver, calls } = createMockDriver(() => ({ records: [] }));
    const service = new AuditQueryService(driver);

    await service.search({ obligationId: "ob-42" });

    expect(calls[0].params.obligationId).toBe("ob-42");
  });

  // FR-3 (partial): proves circularId is wired through as a literal
  // parameter into the same query whose Cypher shape (asserted in the
  // preceding test) traverses Circular <- PART_OF <- Clause <- DERIVED_FROM
  // <- Obligation -> REVIEWED_BY -> HumanReview. It does NOT prove that
  // traversal actually returns every HumanReview across every Obligation
  // derived from any Clause of that Circular against real multi-Obligation
  // graph data — the mock driver returns canned records regardless of the
  // Cypher's real semantics. That end-to-end claim is Acceptance
  // Criterion 2, which needs a real Neo4j integration test (not present in
  // this sandbox — see this file's top-of-file honesty note).
  it("wires circularId through as a literal parameter", async () => {
    const { driver, calls } = createMockDriver(() => ({ records: [] }));
    const service = new AuditQueryService(driver);

    await service.search({ circularId: "circ-42" });

    expect(calls[0].params.circularId).toBe("circ-42");
  });

  // FR-5: reviewerId performs a case-insensitive substring (CONTAINS)
  // match, not exact-match-only — asserted structurally in the preceding
  // shape test (`toLower(hr.reviewer_id) CONTAINS toLower($reviewerId)`);
  // this test proves the value itself is wired through unmodified.
  it("wires reviewerId through for the CONTAINS substring match", async () => {
    const { driver, calls } = createMockDriver(() => ({ records: [] }));
    const service = new AuditQueryService(driver);

    await service.search({ reviewerId: "alice" });

    expect(calls[0].params.reviewerId).toBe("alice");
  });

  // FR-4: freeText performs a case-insensitive CONTAINS match OR'ed across
  // requirement_text/title/para_ref (asserted structurally in the
  // preceding shape test); this test proves the value is wired through.
  it("wires freeText through", async () => {
    const { driver, calls } = createMockDriver(() => ({ records: [] }));
    const service = new AuditQueryService(driver);

    await service.search({ freeText: "disclosure" });

    expect(calls[0].params.freeText).toBe("disclosure");
  });

  it("passes tier: 'A' through as a literal parameter with no special-cased short-circuit (FR-6: zero rows is a natural DB-level consequence, not application logic)", async () => {
    const { driver, calls } = createMockDriver(() => ({ records: [] }));
    const service = new AuditQueryService(driver);

    const response = await service.search({ tier: "A" });

    // The query still executes against the DB — no bypass path.
    expect(calls).toHaveLength(2);
    expect(calls[0].params.tier).toBe("A");
    expect(response.rows).toEqual([]);
  });

  it("wires decision through", async () => {
    const { driver, calls } = createMockDriver(() => ({ records: [] }));
    const service = new AuditQueryService(driver);

    await service.search({ decision: "reject" });

    expect(calls[0].params.decision).toBe("reject");
  });

  it("wires decidedFrom/decidedTo through", async () => {
    const { driver, calls } = createMockDriver(() => ({ records: [] }));
    const service = new AuditQueryService(driver);

    await service.search({ decidedFrom: "2026-01-01", decidedTo: "2026-01-31" });

    expect(calls[0].params.decidedFrom).toBe("2026-01-01");
    expect(calls[0].params.decidedTo).toBe("2026-01-31");
  });

  // FR-9: page/pageSize -> SKIP/LIMIT translation (defaults 1/50, see the
  // shape test above; this test proves a non-default page/pageSize too).
  it("translates page/pageSize into SKIP/LIMIT correctly", async () => {
    const { driver, calls } = createMockDriver(() => ({ records: [] }));
    const service = new AuditQueryService(driver);

    const response = await service.search({ page: 3, pageSize: 20 });

    expect(calls[0].params.skip).toBe(40);
    expect(calls[0].params.limit).toBe(20);
    expect(response.page).toBe(3);
    expect(response.pageSize).toBe(20);
  });

  // NFR-2 / FR-9's pageSize cap.
  it("rejects pageSize > 200 before opening a session", async () => {
    const { driver, sessionCallCount } = createMockDriver(() => ({ records: [] }));
    const service = new AuditQueryService(driver);

    await expect(service.search({ pageSize: 201 })).rejects.toBeInstanceOf(ValidationError);
    expect(sessionCallCount()).toBe(0);
  });

  it("maps a full record (review + lineage + tasks) into an AuditTrailRow", async () => {
    const { driver } = createMockDriver((cypher) =>
      cypher.includes("count(DISTINCT hr)") ? { records: [mockRecord({ total: 1 })] } : { records: [fullSearchRecord()] }
    );
    const service = new AuditQueryService(driver);

    const response = await service.search({ obligationId: "ob-1" });

    expect(response.rows).toHaveLength(1);
    const row = response.rows[0];
    expect(row.review.review_id).toBe("rev-1");
    expect(row.obligation.obligation_id).toBe("ob-1");
    expect(row.clause).toEqual({ clause_id: "cl-1", para_ref: "46" });
    expect(row.circular?.circular_id).toBe("circ-1");
    expect(row.processTasks).toEqual([]);
  });

  it("tolerates a missing clause/circular (orphaned lineage) without dropping the row (§8)", async () => {
    const { driver } = createMockDriver((cypher) =>
      cypher.includes("count(DISTINCT hr)")
        ? { records: [mockRecord({ total: 1 })] }
        : { records: [mockRecord({ o: { properties: baseObligationProps }, hr: { properties: baseReviewProps }, cl: null, c: null, tasks: [] })] }
    );
    const service = new AuditQueryService(driver);

    const response = await service.search({});

    expect(response.rows).toHaveLength(1);
    expect(response.rows[0].clause).toBeNull();
    expect(response.rows[0].circular).toBeNull();
  });
});

describe("AuditQueryService.findByReviewId", () => {
  it("matches by HumanReview.review_id and includes the FR-11a guard in its own WHERE", async () => {
    const { driver, calls } = createMockDriver(() => ({ records: [] }));
    const service = new AuditQueryService(driver);

    await service.findByReviewId("rev-1");

    expect(calls).toHaveLength(1);
    expect(calls[0].cypher).toContain("MATCH (o:Obligation)-[:REVIEWED_BY]->(hr:HumanReview {review_id: $reviewId})");
    expect(calls[0].cypher).toContain(FR_11A_GUARD_STRING);
    expect(calls[0].params).toEqual({ reviewId: "rev-1" });
  });

  // FR-10 (service-layer half): findByReviewId returns null (not a thrown
  // error) for an unknown id — the route handler (reviews/[reviewId]/
  // route.test.ts) is what actually asserts this becomes an HTTP 404, not
  // an empty 200; this test only proves the service-layer contract the
  // route depends on.
  it("returns null (not a 404-shaped error) when nothing matches", async () => {
    const { driver } = createMockDriver(() => ({ records: [] }));
    const service = new AuditQueryService(driver);

    const result = await service.findByReviewId("does-not-exist");

    expect(result).toBeNull();
  });

  // FR-10: full AuditTrailRow (lineage included) for a known review_id.
  it("returns the full AuditTrailRow for a known review_id", async () => {
    const { driver } = createMockDriver(() => ({ records: [fullSearchRecord()] }));
    const service = new AuditQueryService(driver);

    const result = await service.findByReviewId("rev-1");

    expect(result?.review.review_id).toBe("rev-1");
    expect(result?.circular?.title).toBe("Sample Circular");
  });
});

describe("AuditQueryService.findByObligationId", () => {
  // FR-7 (Cypher-level half): ORDER BY hr.decided_at ASC.
  it("matches by Obligation.obligation_id, orders by decided_at ASC, and includes the FR-11a guard", async () => {
    const { driver, calls } = createMockDriver(() => ({ records: [] }));
    const service = new AuditQueryService(driver);

    await service.findByObligationId("ob-1");

    expect(calls).toHaveLength(1);
    expect(calls[0].cypher).toContain("MATCH (o:Obligation {obligation_id: $obligationId})-[:REVIEWED_BY]->(hr:HumanReview)");
    expect(calls[0].cypher).toContain(FR_11A_GUARD_STRING);
    expect(calls[0].cypher).toContain("ORDER BY hr.decided_at ASC");
    expect(calls[0].params).toEqual({ obligationId: "ob-1" });
  });

  // FR-2: filtering by obligationId returns every HumanReview fact linked
  // via REVIEWED_BY — the 0-row case (this test) and the 2-row case (next
  // test) together cover the "0, 1, or 2 rows per the tier policy" claim
  // (1 row, e.g. a resolved Tier B item, follows the same code path and
  // isn't separately re-asserted here).
  it("returns 0 rows for an obligation with no HumanReview facts", async () => {
    const { driver } = createMockDriver(() => ({ records: [] }));
    const service = new AuditQueryService(driver);

    const rows = await service.findByObligationId("ob-no-reviews");

    expect(rows).toEqual([]);
  });

  // FR-2 / FR-7: both Tier C maker+checker HumanReview rows returned,
  // ordered by decided_at ascending (see the "orders by decided_at ASC"
  // assertion in the preceding describe-block test for the Cypher-level
  // proof; this test proves the service returns both rows in that order
  // once the mock driver supplies them). The audit-results-table's actual
  // "Tier C — 2 of 2 reviews" grouping UI (also part of FR-7) is a
  // component-rendering concern, not testable in this node-environment
  // suite (no jsdom/RTL — see this app's own vitest.config.ts doc comment
  // for apps/web-console, mirrored by this package's node-only config).
  it("returns both rows (maker + checker) for a resolved Tier C obligation", async () => {
    const makerRecord = mockRecord({
      o: { properties: { ...baseObligationProps, status: "committed" } },
      hr: { properties: { ...baseReviewProps, review_id: "rev-maker", tier: "C", decided_at: "2026-01-05T00:00:00Z" } },
      cl: { properties: baseClauseProps },
      c: { properties: baseCircularProps },
      tasks: []
    });
    const checkerRecord = mockRecord({
      o: { properties: { ...baseObligationProps, status: "committed" } },
      hr: { properties: { ...baseReviewProps, review_id: "rev-checker", tier: "C", decided_at: "2026-01-05T00:10:00Z" } },
      cl: { properties: baseClauseProps },
      c: { properties: baseCircularProps },
      tasks: []
    });
    const { driver } = createMockDriver(() => ({ records: [makerRecord, checkerRecord] }));
    const service = new AuditQueryService(driver);

    const rows = await service.findByObligationId("ob-1");

    expect(rows).toHaveLength(2);
    expect(rows[0].review.review_id).toBe("rev-maker");
    expect(rows[1].review.review_id).toBe("rev-checker");
  });
});

describe("AuditQueryService.findRegisterAsOf — FR-11a placement (§4.4)", () => {
  it("uses pointInTimeWhereClause for the outer valid-time predicate and places the FR-11a guard INSIDE the REVIEWED_BY OPTIONAL MATCH's own WHERE, not the outer WHERE", async () => {
    const { driver, calls } = createMockDriver(() => ({ records: [] }));
    const service = new AuditQueryService(driver);

    await service.findRegisterAsOf({ asOfDate: "2026-07-01" });

    expect(calls).toHaveLength(1);
    const cypher = calls[0].cypher;

    // Outer valid-time predicate (Spec 01's pointInTimeWhereClause, reused
    // verbatim — not reimplemented).
    expect(cypher).toContain("o.valid_from <= date($asOfDate)");
    expect(cypher).toContain("o.valid_to IS NULL OR o.valid_to > date($asOfDate)");

    // The guard must appear textually AFTER the REVIEWED_BY OPTIONAL MATCH
    // line (i.e. inside that clause's own WHERE), not before it (which
    // would put it in the outer/top-level WHERE and either wrongly drop
    // the whole Obligation row or fail to exclude the leaked review,
    // depending on how it were phrased there).
    const reviewedByIndex = cypher.indexOf("OPTIONAL MATCH (o)-[:REVIEWED_BY]->(hr:HumanReview)");
    const guardIndex = cypher.indexOf(FR_11A_GUARD_STRING);
    const outerWhereIndex = cypher.indexOf("WHERE o.valid_from");
    expect(reviewedByIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeGreaterThan(reviewedByIndex);
    expect(guardIndex).toBeGreaterThan(outerWhereIndex);

    // The guard is scoped to the REVIEWED_BY OPTIONAL MATCH's own WHERE
    // (immediately preceded by the tier filter predicate, both under the
    // same "WHERE ... AND ..." for that clause), not a second top-level
    // WHERE keyword repeating the outer predicate.
    const reviewedByBlock = cypher.slice(reviewedByIndex, cypher.indexOf("OPTIONAL MATCH (o)-[:APPLIES_TO]"));
    expect(reviewedByBlock).toContain("WHERE ($tier IS NULL OR hr.tier = $tier)");
    expect(reviewedByBlock).toContain(FR_11A_GUARD_STRING);
  });

  it("carries category/intermediaryCategoryName/tier filters as literal parameters", async () => {
    const { driver, calls } = createMockDriver(() => ({ records: [] }));
    const service = new AuditQueryService(driver);

    await service.findRegisterAsOf({
      asOfDate: "2026-07-05",
      category: "disclosure",
      intermediaryCategoryName: "Stockbroker",
      tier: "C"
    });

    expect(calls[0].params).toEqual({
      asOfDate: "2026-07-05",
      category: "disclosure",
      intermediaryCategoryName: "Stockbroker",
      tier: "C"
    });
  });

  it("never drops the Obligation row when REVIEWED_BY has no visible match (Tier A, or an FR-11a-suppressed in-progress review) — reviews comes back empty, not the row itself", async () => {
    const { driver } = createMockDriver(() => ({
      records: [
        mockRecord({
          o: { properties: { ...baseObligationProps, status: "tier_a_committed" } },
          cl: { properties: baseClauseProps },
          c: { properties: baseCircularProps },
          tasks: [],
          reviews: []
        })
      ]
    }));
    const service = new AuditQueryService(driver);

    const rows = await service.findRegisterAsOf({ asOfDate: "2026-07-01" });

    expect(rows).toHaveLength(1);
    expect(rows[0].obligation.obligation_id).toBe("ob-1");
    expect(rows[0].reviews).toEqual([]);
  });

  it("collects multiple ProcessTask/HumanReview matches (Tier C resolved) onto one row", async () => {
    const { driver } = createMockDriver(() => ({
      records: [
        mockRecord({
          o: { properties: { ...baseObligationProps, status: "committed" } },
          cl: { properties: baseClauseProps },
          c: { properties: baseCircularProps },
          tasks: [{ properties: { task_id: "task-1", obligation_id: "ob-1", task_name: "File form", owner_role: "Ops", sla_hours: 24, system_touchpoint: "portal", risk_score: 0.5, valid_from: "2026-01-01", valid_to: null, recorded_at: "2026-01-01T00:00:00Z" } }],
          reviews: [
            { properties: { ...baseReviewProps, review_id: "rev-maker", tier: "C" } },
            { properties: { ...baseReviewProps, review_id: "rev-checker", tier: "C" } }
          ]
        })
      ]
    }));
    const service = new AuditQueryService(driver);

    const rows = await service.findRegisterAsOf({ asOfDate: "2026-07-01" });

    expect(rows).toHaveLength(1);
    expect(rows[0].tasks).toHaveLength(1);
    expect(rows[0].tasks[0].task_id).toBe("task-1");
    expect(rows[0].reviews).toHaveLength(2);
    expect(rows[0].reviews.map((r) => r.review_id).sort()).toEqual(["rev-checker", "rev-maker"]);
  });

  it("uses an explicit 60s transaction timeout config (§8 export-generation-query timeout)", async () => {
    let capturedConfig: unknown;
    const driver = {
      session: () => ({
        executeRead: async (work: (tx: unknown) => unknown, config: unknown) => {
          capturedConfig = config;
          return work({ run: async () => ({ records: [] }) });
        },
        close: async () => undefined
      })
    } as unknown as import("neo4j-driver").Driver;
    const service = new AuditQueryService(driver);

    await service.findRegisterAsOf({ asOfDate: "2026-07-01" });

    expect(capturedConfig).toEqual({ timeout: 60_000 });
  });
});

describe("AuditQueryService.countRegisterAsOf (added Spec 10 stage: API-layer FR-12 support)", () => {
  it("uses the same point-in-time predicate and FR-11a guard placement as findRegisterAsOf, and a count(*)-shaped RETURN (no node property hydration)", async () => {
    const { driver, calls } = createMockDriver(() => ({ records: [mockRecord({ total: 0 })] }));
    const service = new AuditQueryService(driver);

    await service.countRegisterAsOf({ asOfDate: "2026-07-01" });

    expect(calls).toHaveLength(1);
    const cypher = calls[0].cypher;
    expect(cypher).toContain("o.valid_from <= date($asOfDate)");
    expect(cypher).toContain("o.valid_to IS NULL OR o.valid_to > date($asOfDate)");
    expect(cypher).toContain(FR_11A_GUARD_STRING);
    expect(cypher).toContain("count(DISTINCT pt) AS taskCount");
    expect(cypher).toContain("count(DISTINCT hr) AS reviewCount");
    expect(cypher).toContain("RETURN sum(");
    // Not a node-hydrating query: no bare `RETURN o` (full node) anywhere.
    expect(cypher).not.toContain("RETURN o, cl, c, tasks, reviews");
  });

  it("returns 0 (not null/NaN) when zero Obligations match", async () => {
    const { driver } = createMockDriver(() => ({ records: [mockRecord({ total: null })] }));
    const service = new AuditQueryService(driver);

    const count = await service.countRegisterAsOf({ asOfDate: "2026-07-01" });

    expect(count).toBe(0);
  });

  it("multiplies per-Obligation task-count x review-count (each floored at 1) — mirrors to-register-rows.ts's cross-product rule", async () => {
    // Cypher itself computes the sum server-side; this test only verifies
    // the mock's returned aggregate is passed through untouched.
    const { driver } = createMockDriver(() => ({ records: [mockRecord({ total: 7 })] }));
    const service = new AuditQueryService(driver);

    const count = await service.countRegisterAsOf({ asOfDate: "2026-07-01" });

    expect(count).toBe(7);
  });

  it("carries category/intermediaryCategoryName/tier filters as literal parameters", async () => {
    const { driver, calls } = createMockDriver(() => ({ records: [mockRecord({ total: 0 })] }));
    const service = new AuditQueryService(driver);

    await service.countRegisterAsOf({
      asOfDate: "2026-07-05",
      category: "disclosure",
      intermediaryCategoryName: "Stockbroker",
      tier: "C"
    });

    expect(calls[0].params).toEqual({
      asOfDate: "2026-07-05",
      category: "disclosure",
      intermediaryCategoryName: "Stockbroker",
      tier: "C"
    });
  });

  it("uses the same 60s transaction timeout as findRegisterAsOf", async () => {
    let capturedConfig: unknown;
    const driver = {
      session: () => ({
        executeRead: async (work: (tx: unknown) => unknown, config: unknown) => {
          capturedConfig = config;
          return work({ run: async () => ({ records: [mockRecord({ total: 0 })] }) });
        },
        close: async () => undefined
      })
    } as unknown as import("neo4j-driver").Driver;
    const service = new AuditQueryService(driver);

    await service.countRegisterAsOf({ asOfDate: "2026-07-01" });

    expect(capturedConfig).toEqual({ timeout: 60_000 });
  });
});
