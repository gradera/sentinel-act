// Real neo4j-driver-backed adapter for `ChangeAndDeltaGraphPort`
// (Spec 06 §4). Unit tests pass a hand-rolled fake port; this adapter is
// only used when Spec 08 wires this unit up to a live @sentinel-act/graph-db
// Driver.
//
// Every query here is READ-ONLY and parameterized (NFR-6/NFR-8). The four
// Cypher shapes are exactly those the spec §4 documents as owned by
// Spec 01. `para_ref` values originate from regex extraction over
// untrusted regulator text, so they are always passed as parameters, never
// interpolated. There is deliberately no CREATE/MERGE/SET/DELETE anywhere
// in this file — grep-verifiable per Definition of Done.
//
// Duck-typed against the minimal neo4j-driver `Driver`/`Session` shape
// this adapter needs (same posture as mapping-risk-scoring.graph.ts): a
// real Driver from @sentinel-act/graph-db satisfies it structurally, so no
// direct `neo4j-driver` import is required.
import type { Circular, Clause, Obligation, ProcessTask } from "@sentinel-act/graph-schema";
import type { ChangeAndDeltaGraphPort } from "./change-and-delta.types.js";

// ---------------------------------------------------------------------------
// Cypher (Spec 06 §4 — read-only, parameterized)
// ---------------------------------------------------------------------------

const LIVE_OBLIGATIONS_UNDER_CIRCULAR = `
  MATCH (o:Obligation)-[:DERIVED_FROM]->(c:Clause)-[:PART_OF]->(circ:Circular {circular_id: $circularId})
  WHERE o.valid_to IS NULL
  RETURN o, c
`;

const CLAUSE_BY_PARA_REF = `
  MATCH (c:Clause {circular_id: $circularId, para_ref: $paraRef})
  RETURN c
  LIMIT 1
`;

const ALL_CLAUSES_UNDER_CIRCULAR = `
  MATCH (c:Clause)-[:PART_OF]->(circ:Circular {circular_id: $circularId})
  RETURN c
`;

const LIVE_PROCESS_TASK_FOR_OBLIGATION = `
  MATCH (t:ProcessTask {obligation_id: $obligationId})
  WHERE t.valid_to IS NULL
  RETURN t
  LIMIT 1
`;

const CIRCULAR_BY_ID = `
  MATCH (circ:Circular {circular_id: $circularId})
  RETURN circ
  LIMIT 1
`;

// ---------------------------------------------------------------------------
// Duck-typed driver shape
// ---------------------------------------------------------------------------
interface Neo4jNodeLike {
  properties: Record<string, unknown>;
}
interface Neo4jRecordLike {
  get(key: string): Neo4jNodeLike | null;
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

// ---------------------------------------------------------------------------
// Lightweight deserialization. neo4j-driver surfaces numeric properties as
// JS numbers here (small values) or {low, high} Integer objects; coerce to
// number defensively. Bitemporal/text fields pass through as-is.
// ---------------------------------------------------------------------------
function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (value && typeof value === "object" && "low" in (value as Record<string, unknown>)) {
    return Number((value as { low: number }).low);
  }
  return Number(value);
}

function deserializeObligation(props: Record<string, unknown>): Obligation {
  return {
    obligation_id: String(props.obligation_id),
    derived_from_clause_id: String(props.derived_from_clause_id),
    category: String(props.category),
    requirement_text: String(props.requirement_text),
    trigger_event: String(props.trigger_event),
    deadline_rule: String(props.deadline_rule),
    responsible_role: String(props.responsible_role),
    evidence_required: String(props.evidence_required),
    penalty_ref: props.penalty_ref == null ? null : String(props.penalty_ref),
    confidence_score: toNumber(props.confidence_score),
    grounding_score: toNumber(props.grounding_score),
    status: props.status as Obligation["status"],
    valid_from: String(props.valid_from),
    valid_to: props.valid_to == null ? null : String(props.valid_to),
    recorded_at: String(props.recorded_at)
  };
}

function deserializeClause(props: Record<string, unknown>): Clause {
  return {
    clause_id: String(props.clause_id),
    circular_id: String(props.circular_id),
    para_ref: String(props.para_ref),
    text: String(props.text),
    embedding_ref: typeof props.embedding_ref === "string" ? props.embedding_ref : "",
    valid_from: String(props.valid_from),
    valid_to: props.valid_to == null ? null : String(props.valid_to),
    recorded_at: String(props.recorded_at)
  };
}

function deserializeProcessTask(props: Record<string, unknown>): ProcessTask {
  return {
    task_id: String(props.task_id),
    obligation_id: String(props.obligation_id),
    task_name: String(props.task_name),
    owner_role: String(props.owner_role),
    sla_hours: toNumber(props.sla_hours),
    system_touchpoint: String(props.system_touchpoint),
    risk_score: toNumber(props.risk_score),
    valid_from: String(props.valid_from),
    valid_to: props.valid_to == null ? null : String(props.valid_to),
    recorded_at: String(props.recorded_at)
  };
}

function deserializeCircular(props: Record<string, unknown>): Circular {
  return {
    circular_id: String(props.circular_id),
    title: String(props.title),
    type: String(props.type),
    category: String(props.category),
    date_issued: String(props.date_issued),
    date_effective: String(props.date_effective),
    source_hash: String(props.source_hash),
    supersedes_circular_id: props.supersedes_circular_id == null ? null : String(props.supersedes_circular_id),
    valid_from: String(props.valid_from),
    valid_to: props.valid_to == null ? null : String(props.valid_to),
    recorded_at: String(props.recorded_at)
  };
}

async function runRead(driver: Neo4jDriverLike, database: string | undefined, query: string, params: Record<string, unknown>): Promise<Neo4jRecordLike[]> {
  const session = driver.session(database ? { database } : undefined);
  try {
    const result = await session.executeRead((tx) => tx.run(query, params));
    return result.records;
  } finally {
    await session.close();
  }
}

/** Build a live, read-only `ChangeAndDeltaGraphPort` over a neo4j Driver. */
export function createChangeAndDeltaGraphPortFromDriver(driver: Neo4jDriverLike, database?: string): ChangeAndDeltaGraphPort {
  return {
    async getLiveObligationsUnderCircular(circularId: string) {
      const records = await runRead(driver, database, LIVE_OBLIGATIONS_UNDER_CIRCULAR, { circularId });
      return records.map((record) => ({
        obligation: deserializeObligation(record.get("o")!.properties),
        clause: deserializeClause(record.get("c")!.properties)
      }));
    },

    async getClauseByParaRef(circularId: string, paraRef: string) {
      const records = await runRead(driver, database, CLAUSE_BY_PARA_REF, { circularId, paraRef });
      const node = records[0]?.get("c");
      return node ? deserializeClause(node.properties) : null;
    },

    async getAllClausesUnderCircular(circularId: string) {
      const records = await runRead(driver, database, ALL_CLAUSES_UNDER_CIRCULAR, { circularId });
      return records.map((record) => deserializeClause(record.get("c")!.properties));
    },

    async getLiveProcessTaskForObligation(obligationId: string) {
      const records = await runRead(driver, database, LIVE_PROCESS_TASK_FOR_OBLIGATION, { obligationId });
      const node = records[0]?.get("t");
      return node ? deserializeProcessTask(node.properties) : null;
    },

    async getCircular(circularId: string) {
      const records = await runRead(driver, database, CIRCULAR_BY_ID, { circularId });
      const node = records[0]?.get("circ");
      return node ? deserializeCircular(node.properties) : null;
    }
  };
}
