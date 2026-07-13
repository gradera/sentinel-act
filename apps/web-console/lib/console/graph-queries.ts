// Spec 09 §4 "Cypher query shape (read path, BFF → Neo4j directly, mirrors
// Spec 05's GraphQueryPort pattern)" — a narrow, READ-ONLY graph access
// layer for this app's future BFF route handlers, backed by
// @sentinel-act/graph-db's real exports (createDriver/getDriver,
// ObligationRepository/ProcessTaskRepository/ClauseRepository/
// CircularRepository/EvidenceArtifactRepository, findObligationsAsOf).
//
// ***** HARD INVARIANT: apps/web-console NEVER writes to Neo4j *****
// (Spec 00 §4: "the Orchestrator is the only thing that commits to the
// graph"; Spec 09 DoD: "grep check ... no direct Neo4j write call exists
// anywhere in apps/web-console"). Every Cypher string in this file is a
// MATCH/OPTIONAL MATCH/RETURN read — there is no CREATE/MERGE/SET/DELETE
// anywhere below, and there must never be. All parameters are bound via
// Cypher `$param` placeholders (NFR-Security-4) — never string-interpolated.
//
// ***** SECOND HARD INVARIANT: no HumanReview reads here, ever *****
// Spec 09 §3 scopes this BFF's direct Neo4j read access to
// Obligation/Clause/Circular/ProcessTask ONLY. `HumanReview` data
// (who decided what) is read exclusively through the Orchestrator's
// `GET .../review-gate` endpoint (orchestrator-client.ts's
// `getReviewGate`), which applies Spec 07's `getReviewsVisibleTo`
// per-caller redaction (FR-18, NFR-Security-1) — that is the ENTIRE
// mechanism the Tier C maker-checker independence guarantee rests on. A
// direct `MATCH (:Obligation)-[:REVIEWED_BY]->(:HumanReview)` query
// added to this file later would silently bypass that redaction and
// leak a peer reviewer's decision. There is no `HumanReviewRepository`
// import in this file, and there must never be one.
import { getDriver, getSingletonDatabase, ObligationRepository, ProcessTaskRepository } from "@sentinel-act/graph-db";
import type { Driver, Session } from "neo4j-driver";
import neo4jDriverPkg from "neo4j-driver";
import type { Circular, Clause, Obligation, ObligationStatus, ProcessTask } from "@sentinel-act/graph-schema";

// ---------------------------------------------------------------------------
// GraphQueryPort — same narrow shape risk-score.scorer.ts (Spec 05) and
// monitoring-and-audit.agent.ts (Spec 07) each independently define
// (`runCypher<T>(query, params): Promise<T[]>`). @sentinel-act/graph-db
// does not export one canonical `GraphQueryPort` symbol (confirmed by
// reading packages/graph-db/src/index.ts in full) — every consuming spec
// defines its own copy of this exact shape rather than a shared import,
// which this file follows for consistency with the rest of the codebase.
// ---------------------------------------------------------------------------

export interface GraphQueryPort {
  runCypher<T = Record<string, unknown>>(query: string, params: Record<string, unknown>): Promise<T[]>;
}

class Neo4jGraphQueryPort implements GraphQueryPort {
  constructor(private readonly driver: Driver) {}

  async runCypher<T = Record<string, unknown>>(query: string, params: Record<string, unknown>): Promise<T[]> {
    const session: Session = this.driver.session({ database: getSingletonDatabase() });
    try {
      const result = await session.executeRead((tx) => tx.run(query, params));
      return result.records.map((record) => record.toObject() as T);
    } finally {
      await session.close();
    }
  }
}

/** Defaults to the process-wide `getDriver()` singleton (reads
 *  `SENTINEL_NEO4J_URI`/`_USER`/`_PASSWORD`/`_DATABASE` from env, same as
 *  every other app in this monorepo) — pass an explicit `Driver` in
 *  tests. */
export function createGraphQueryPort(driver: Driver = getDriver()): GraphQueryPort {
  return new Neo4jGraphQueryPort(driver);
}

// ---------------------------------------------------------------------------
// Local node-property deserialization.
//
// packages/graph-db's `serializeProperties` (repositories/serialize.ts) —
// the function that turns a raw Neo4j node-properties bag (driver-native
// Date/DateTime/Integer wrapper objects, and Neo4j's "absent property"
// vs. graph-schema's "explicit null" mismatch) into a well-typed,
// graph-schema-shaped object — is NOT exported from
// packages/graph-db/src/index.ts (confirmed by reading that file in
// full: only `logOperation`/`LogOperationInput` are exported from the
// logging module, and the repository classes use `serializeProperties`
// internally but never re-export it). That function's behavior is
// reproduced here, narrowly, ONLY for the multi-node JOIN queries below
// where a repository's own `findById`/`findAllAsOf` (which already call
// `serializeProperties` correctly) cannot express the query shape
// (arbitrary `status IN [...]` + cross-label JOIN + `ORDER BY
// t.risk_score` + pagination). This is the same "hand-unwrap a raw
// driver row" pattern monitoring-and-audit.agent.ts's own
// `unwrapNodeProperties` already uses for the identical reason (GraphQueryPort
// rows are not repository-hydrated). Duplicated, not imported, because
// there is nothing to import — flagged here so a future spec/PR that
// wants to add a shared exported version to packages/graph-db has a
// clear paper trail of why this duplication exists.
// ---------------------------------------------------------------------------

const neo4j = neo4jDriverPkg;

function deserializeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value ?? null;
  }
  if (neo4j.isDate(value) || neo4j.isDateTime(value) || neo4j.isLocalDateTime(value) || neo4j.isTime(value)) {
    return (value as { toString(): string }).toString();
  }
  if (neo4j.isInt(value)) {
    return (value as { toNumber(): number }).toNumber();
  }
  if (Array.isArray(value)) {
    return value.map(deserializeValue);
  }
  return value;
}

function deserializeNodeProperties<T>(properties: Record<string, unknown>, nullableFields: readonly string[]): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (key.startsWith("_")) continue;
    out[key] = deserializeValue(value);
  }
  for (const field of nullableFields) {
    if (!(field in out)) {
      out[field] = null;
    }
  }
  return out as T;
}

/** Neo4j driver rows return whole nodes as `{ properties, labels, ... }`
 *  objects; `record.toObject()` preserves that shape for node-valued
 *  RETURN columns (scalar columns like `circ.title AS circularTitle`
 *  come back as plain values already). Mirrors monitoring-and-audit.
 *  agent.ts's `unwrapNodeProperties` doc comment for the same reason:
 *  defensive against a hand-rolled fake `GraphQueryPort` in tests that
 *  returns plain property maps directly instead. */
function unwrapNode(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "object" && "properties" in (value as Record<string, unknown>)) {
    return (value as { properties: Record<string, unknown> }).properties;
  }
  return value as Record<string, unknown>;
}

// nullableFields per label — kept in lockstep with each repository's own
// `nullableFields` getter override (base.repository.ts's doc comment
// explains why this list exists at all: Neo4j drops null-valued
// properties instead of storing them).
const OBLIGATION_NULLABLE_FIELDS = ["valid_to", "penalty_ref"] as const;
const PROCESS_TASK_NULLABLE_FIELDS = ["valid_to"] as const;
const CLAUSE_NULLABLE_FIELDS = ["valid_to"] as const;
const CIRCULAR_NULLABLE_FIELDS = ["valid_to", "supersedes_circular_id"] as const;

function toObligation(raw: Record<string, unknown>): Obligation {
  return deserializeNodeProperties<Obligation>(raw, OBLIGATION_NULLABLE_FIELDS);
}
function toProcessTask(raw: Record<string, unknown>): ProcessTask {
  return deserializeNodeProperties<ProcessTask>(raw, PROCESS_TASK_NULLABLE_FIELDS);
}
function toClause(raw: Record<string, unknown>): Clause {
  // NOTE: does NOT apply ClauseRepository's embedding_ref JSON<->LIST<FLOAT>
  // boundary conversion (clause.repository.ts's fromGraphEmbedding) — the
  // console's read path never needs the embedding vector (it only ever
  // displays `Clause.text`/`para_ref`), so `embedding_ref` is left as
  // whatever raw shape Neo4j returned rather than paying for a conversion
  // nothing here consumes. Do not read `.embedding_ref` off a `Clause`
  // returned by this file without adding that conversion first.
  return deserializeNodeProperties<Clause>(raw, CLAUSE_NULLABLE_FIELDS);
}
function toCircular(raw: Record<string, unknown>): Circular {
  return deserializeNodeProperties<Circular>(raw, CIRCULAR_NULLABLE_FIELDS);
}

// ---------------------------------------------------------------------------
// fetchQueueItems — Spec 09 §4's exact queue Cypher shape (Task 2).
// ---------------------------------------------------------------------------

export interface QueueGraphFilters {
  /** MUST already default to `["tier_b_review", "tier_c_review",
   *  "escalated"]` at the caller (FR-1) — this function applies whatever
   *  list it is given verbatim, it does not itself enforce "Tier A never
   *  appears" (that is a route-handler-level default, not a graph-layer
   *  invariant, since ObligationStatus has no tier information the graph
   *  layer could check). */
  statuses: ObligationStatus[];
  skip: number;
  limit: number;
}

export interface QueueGraphRow {
  obligation: Obligation;
  processTask: ProcessTask;
  clauseParaRef: string | null;
  circularTitle: string | null;
}

interface QueueGraphRawRow {
  o: unknown;
  t: unknown;
  clauseParaRef: string | null;
  circularTitle: string | null;
}

const QUEUE_ITEMS_CYPHER = `
  MATCH (o:Obligation)-[:MAPPED_TO]->(t:ProcessTask)
  WHERE o.status IN $statuses
  OPTIONAL MATCH (o)-[:DERIVED_FROM]->(c:Clause)-[:PART_OF]->(circ:Circular)
  RETURN o, t, c.para_ref AS clauseParaRef, circ.title AS circularTitle
  ORDER BY t.risk_score DESC
  SKIP $skip LIMIT $limit
`;

/** Returns up to `filters.limit` rows, already sorted `risk_score DESC`
 *  per FR-5's server-side-sort requirement (the `slaDueAt ASC` secondary
 *  sort FR-5 also requires must be applied by the caller AFTER merging
 *  in the Orchestrator's per-item SLA data — this function has no access
 *  to that, per Spec 09 §4's documented "deliberate split" between graph
 *  content and Orchestrator-owned timing state). A later BFF stage
 *  should fetch `limit + 1` rows to derive `nextCursor` (not done here —
 *  this function is a direct, unopinionated translation of the query
 *  shape, pagination-envelope decisions belong to the route handler). */
export async function fetchQueueItems(filters: QueueGraphFilters, port: GraphQueryPort = createGraphQueryPort()): Promise<QueueGraphRow[]> {
  const rows = await port.runCypher<QueueGraphRawRow>(QUEUE_ITEMS_CYPHER, {
    statuses: filters.statuses,
    skip: filters.skip,
    limit: filters.limit
  });

  const results: QueueGraphRow[] = [];
  for (const row of rows) {
    const obligationRaw = unwrapNode(row.o);
    const taskRaw = unwrapNode(row.t);
    if (!obligationRaw || !taskRaw) {
      // Malformed row (should be impossible given the MATCH pattern
      // requires both) — skip rather than throw, same defensive posture
      // as scanForSlaGaps's malformed-row handling (monitoring-and-audit.
      // agent.ts).
      continue;
    }
    results.push({
      obligation: toObligation(obligationRaw),
      processTask: toProcessTask(taskRaw),
      clauseParaRef: row.clauseParaRef ?? null,
      circularTitle: row.circularTitle ?? null
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// fetchObligationDetail — Spec 09 §4's exact item-detail Cypher shape
// (Task 3).
// ---------------------------------------------------------------------------

export interface ObligationDetailGraphRow {
  obligation: Obligation;
  clause: Clause;
  circular: Circular;
  processTask: ProcessTask | null;
  priorObligation: Obligation | null;
  priorProcessTask: ProcessTask | null;
}

interface ObligationDetailRawRow {
  o: unknown;
  c: unknown;
  circ: unknown;
  t: unknown;
  priorObl: unknown;
  priorTask: unknown;
}

const OBLIGATION_DETAIL_CYPHER = `
  MATCH (o:Obligation {obligation_id: $obligationId})-[:DERIVED_FROM]->(c:Clause)-[:PART_OF]->(circ:Circular)
  OPTIONAL MATCH (o)-[:MAPPED_TO]->(t:ProcessTask)
  OPTIONAL MATCH (o)-[:SUPERSEDES]->(priorObl:Obligation)-[:MAPPED_TO]->(priorTask:ProcessTask)
  RETURN o, c, circ, t, priorObl, priorTask
`;

/** Returns `null` when `obligationId` does not resolve (404 territory
 *  for the route handler — this function does not throw for "not
 *  found", only for a genuine query/connection failure). `processTask`
 *  is `null` for the (should-be-rare) case of an Obligation with no
 *  `MAPPED_TO` edge yet; `priorObligation`/`priorProcessTask` are both
 *  `null` together when this Obligation has no `SUPERSEDES` edge (a
 *  first-version Obligation — the case diff-adapter.ts's
 *  `deriveEmptyOldLabel` renders as "New task"). */
export async function fetchObligationDetail(
  obligationId: string,
  port: GraphQueryPort = createGraphQueryPort()
): Promise<ObligationDetailGraphRow | null> {
  const rows = await port.runCypher<ObligationDetailRawRow>(OBLIGATION_DETAIL_CYPHER, { obligationId });
  const row = rows[0];
  if (!row) {
    return null;
  }

  const obligationRaw = unwrapNode(row.o);
  const clauseRaw = unwrapNode(row.c);
  const circularRaw = unwrapNode(row.circ);
  if (!obligationRaw || !clauseRaw || !circularRaw) {
    return null;
  }

  const taskRaw = unwrapNode(row.t);
  const priorObligationRaw = unwrapNode(row.priorObl);
  const priorTaskRaw = unwrapNode(row.priorTask);

  return {
    obligation: toObligation(obligationRaw),
    clause: toClause(clauseRaw),
    circular: toCircular(circularRaw),
    processTask: taskRaw ? toProcessTask(taskRaw) : null,
    priorObligation: priorObligationRaw ? toObligation(priorObligationRaw) : null,
    priorProcessTask: priorTaskRaw ? toProcessTask(priorTaskRaw) : null
  };
}

// Re-exported so a later stage can hydrate a single Obligation/ProcessTask
// by id (e.g. resolving `ContradictionDetail.conflicting_obligation_summary`,
// types.ts) via the real, already-correct repository path instead of a
// bespoke query — no reason to reinvent `findById` for that case.
export { ObligationRepository, ProcessTaskRepository };
