// Read-only graph lookups for the Mapping and Risk Scoring Agent
// (Spec 05 §11 task 6): `deriveOverwritesLiveObligation` (FR-16–FR-19) and
// `isFirstSeenObligationType` (FR-20/FR-21), both wired through the
// `GraphQueryPort` contract from `../scorers/risk-score.scorer.js`, plus a
// real neo4j-driver-backed adapter satisfying that port (Spec 05 §3's
// "adapt the import, not the contract" note — @sentinel-act/graph-db does
// not itself export a generic `runCypher`, so this unit builds its own
// thin adapter over the Driver it does export, rather than modifying
// Spec 01's package).
//
// NFR-5: every query below is parameterized — obligation `category` /
// `responsible_role` originate from LLM extraction over regulator text,
// not operator-trusted input, and are never string-interpolated into
// Cypher. NFR-7: read-only only, no CREATE/MERGE/SET/DELETE anywhere here.
import type { Obligation } from "@sentinel-act/graph-schema";
import type { GraphQueryPort, MappingContext, OverwriteCheckResult, FirstSeenCheckResult } from "../scorers/risk-score.scorer.js";
import { DEFAULT_GRAPH_TIMEOUT_MS } from "../scorers/risk-score.scorer.js";

// ---------------------------------------------------------------------------
// Cypher query shapes (Spec 05 §4)
// ---------------------------------------------------------------------------

const OVERWRITE_EXPLICIT_QUERY = `
  MATCH (newClause:Clause {clause_id: $derivedFromClauseId})-[:PART_OF]->(newCircular:Circular)
  MATCH (newCircular)-[:SUPERSEDES]->(oldCircular:Circular)
  MATCH (oldClause:Clause)-[:PART_OF]->(oldCircular)
  MATCH (liveObligation:Obligation)-[:DERIVED_FROM]->(oldClause)
  WHERE liveObligation.status = 'committed'
    AND liveObligation.valid_to IS NULL
  RETURN liveObligation.obligation_id AS overwrittenObligationId
  LIMIT 1
`;

const OVERWRITE_HEURISTIC_QUERY = `
  MATCH (liveObligation:Obligation {category: $category, responsible_role: $responsibleRole})
  WHERE liveObligation.status = 'committed'
    AND liveObligation.valid_to IS NULL
    AND liveObligation.obligation_id <> $obligationId
  RETURN liveObligation.obligation_id AS overwrittenObligationId
  LIMIT 1
`;

const FIRST_SEEN_QUERY = `
  MATCH (o:Obligation {category: $category, responsible_role: $responsibleRole})
  WHERE o.status IN ['committed', 'tier_a_committed']
    AND o.obligation_id <> $obligationId
  RETURN count(o) > 0 AS typeAlreadySeen
`;

// ---------------------------------------------------------------------------
// Timeout helper (NFR-4)
// ---------------------------------------------------------------------------

class GraphQueryTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphQueryTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new GraphQueryTimeoutError(`Graph query exceeded ${timeoutMs}ms budget`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function runCypherWithTimeout<T = Record<string, unknown>>(
  graph: GraphQueryPort,
  query: string,
  params: Record<string, unknown>,
  timeoutMs: number
): Promise<T[]> {
  return withTimeout(graph.runCypher<T>(query, params), timeoutMs);
}

// ---------------------------------------------------------------------------
// FR-16–FR-19: deriveOverwritesLiveObligation
// ---------------------------------------------------------------------------

interface OverwrittenIdRow {
  overwrittenObligationId: string;
}

/** FR-16–FR-19, §8's fail-closed table: on Neo4j unavailability or a
 *  timeout, returns `{ overwritesLiveObligation: true, matchPath: null,
 *  overwrittenObligationId: null, degraded: true }` — biasing toward more
 *  scrutiny (higher risk score), never less. */
export async function deriveOverwritesLiveObligation(obligation: Obligation, ctx: MappingContext): Promise<OverwriteCheckResult> {
  const timeoutMs = ctx.graphTimeoutMs ?? DEFAULT_GRAPH_TIMEOUT_MS;

  try {
    // Path 1: explicit circular-level supersession chain (FR-16).
    const explicitRows = await runCypherWithTimeout<OverwrittenIdRow>(
      ctx.graph,
      OVERWRITE_EXPLICIT_QUERY,
      { derivedFromClauseId: obligation.derived_from_clause_id },
      timeoutMs
    );
    if (explicitRows.length > 0) {
      return {
        overwritesLiveObligation: true,
        matchPath: "explicit",
        overwrittenObligationId: explicitRows[0].overwrittenObligationId,
        degraded: false
      };
    }

    // Path 2: same category+role heuristic fallback (FR-17), only run if
    // path 1 returns no rows.
    const heuristicRows = await runCypherWithTimeout<OverwrittenIdRow>(
      ctx.graph,
      OVERWRITE_HEURISTIC_QUERY,
      { category: obligation.category, responsibleRole: obligation.responsible_role, obligationId: obligation.obligation_id },
      timeoutMs
    );
    if (heuristicRows.length > 0) {
      return {
        overwritesLiveObligation: true,
        matchPath: "heuristic",
        overwrittenObligationId: heuristicRows[0].overwrittenObligationId,
        degraded: false
      };
    }

    // FR-18: neither path matched.
    return { overwritesLiveObligation: false, matchPath: null, overwrittenObligationId: null, degraded: false };
  } catch {
    // §8: Neo4j unavailable or query timeout -> fail closed, assume
    // overwrite. Never rethrown — this unit must not throw on a degraded
    // graph, only on a genuinely malformed Obligation (MappingValidationError).
    return { overwritesLiveObligation: true, matchPath: null, overwrittenObligationId: null, degraded: true };
  }
}

// ---------------------------------------------------------------------------
// FR-20/FR-21: isFirstSeenObligationType
// ---------------------------------------------------------------------------

interface TypeAlreadySeenRow {
  typeAlreadySeen: boolean;
}

/** FR-20/FR-21, §8's fail-closed table: on Neo4j unavailability or a
 *  timeout, returns `{ isFirstSeenObligationType: true, degraded: true }`
 *  — assume first-seen, which forces at least Tier B (FR-28) rather than
 *  silently allowing Tier A. */
export async function isFirstSeenObligationType(obligation: Obligation, ctx: MappingContext): Promise<FirstSeenCheckResult> {
  const timeoutMs = ctx.graphTimeoutMs ?? DEFAULT_GRAPH_TIMEOUT_MS;

  try {
    const rows = await runCypherWithTimeout<TypeAlreadySeenRow>(
      ctx.graph,
      FIRST_SEEN_QUERY,
      { category: obligation.category, responsibleRole: obligation.responsible_role, obligationId: obligation.obligation_id },
      timeoutMs
    );
    const typeAlreadySeen = rows.length > 0 && Boolean(rows[0].typeAlreadySeen);
    return { isFirstSeenObligationType: !typeAlreadySeen, degraded: false };
  } catch {
    return { isFirstSeenObligationType: true, degraded: true };
  }
}

// ---------------------------------------------------------------------------
// Real neo4j-driver-backed GraphQueryPort adapter
// ---------------------------------------------------------------------------
// Not used by unit tests (which pass a hand-rolled fake per Spec 05 §3),
// only by whatever wires this unit's `runMappingAndRiskScoring` up to a
// live @sentinel-act/graph-db Driver (Spec 08). Kept here rather than in
// packages/graph-db itself, since graph-db does not export a generic
// runCypher and this unit's own dependency note says to adapt the import,
// not the contract.
//
// Deliberately structurally typed (duck-typed) against the minimal shape
// of neo4j-driver's `Driver`/`Session`/`ManagedTransaction` this adapter
// needs, rather than importing the `neo4j-driver` package directly —
// apps/orchestrator does not declare it as a direct dependency (only
// @sentinel-act/graph-db does, transitively, and pnpm's workspace
// isolation does not hoist it), and a real `Driver` instance from
// @sentinel-act/graph-db satisfies this shape structurally, so no runtime
// or type-level coupling to the neo4j-driver package is required here.
interface Neo4jRecordLike {
  toObject(): Record<string, unknown>;
}
interface Neo4jResultLike {
  records: Neo4jRecordLike[];
}
interface Neo4jTransactionLike {
  run(query: string, params: Record<string, unknown>): Promise<Neo4jResultLike>;
}
interface Neo4jSessionLike {
  executeRead<T>(work: (tx: Neo4jTransactionLike) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export interface Neo4jDriverLike {
  session(config?: { database?: string }): Neo4jSessionLike;
}

export function createGraphQueryPortFromDriver(driver: Neo4jDriverLike, database?: string): GraphQueryPort {
  return {
    async runCypher<T = Record<string, unknown>>(query: string, params: Record<string, unknown>): Promise<T[]> {
      const session = driver.session(database ? { database } : undefined);
      try {
        const result = await session.executeRead((tx) => tx.run(query, params));
        return result.records.map((record) => record.toObject() as T);
      } finally {
        await session.close();
      }
    }
  };
}
