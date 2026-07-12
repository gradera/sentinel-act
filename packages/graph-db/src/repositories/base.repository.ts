// Base repository contract + shared implementation (§5.3). Every
// bitemporal node type's repository extends BaseRepository, which
// implements findById/findAsOf/findAllAsOf identically for all of them —
// only `create` (and type-specific methods like `supersede`) differ per
// repository.
import type { Driver, ManagedTransaction, Session } from "neo4j-driver";
import type { Bitemporal } from "@sentinel-act/graph-schema";
import type { CreateInput } from "../types.js";
import { pointInTimeWhereClause } from "../point-in-time.js";
import { getSingletonDatabase } from "../driver.js";
import { logOperation } from "../logger.js";
import { serializeProperties } from "./serialize.js";

export interface GraphRepository<TNode extends Bitemporal, TIdField extends keyof TNode> {
  readonly label: string; // Neo4j node label, e.g. "Obligation"
  readonly idField: TIdField; // primary key property name, e.g. "obligation_id"

  /** Creates one node. Stamps recorded_at server-side. Must be called
   *  inside a transaction when part of a larger commit (see GraphWriter);
   *  standalone calls open+commit their own single-statement transaction. */
  create(input: CreateInput<TNode>, tx?: ManagedTransaction): Promise<TNode>;

  /** Fetch by primary key, latest transaction-time version regardless of
   *  valid_time window (i.e. ignores valid_to). Returns null if absent. */
  findById(id: TNode[TIdField] & string): Promise<TNode | null>;

  /** Bitemporal point-in-time fetch: the version of this node whose
   *  valid_from <= asOfDate < valid_to (or valid_to IS NULL). */
  findAsOf(id: TNode[TIdField] & string, asOfDate: string): Promise<TNode | null>;

  /** All nodes of this label valid as of a given date, optionally
   *  filtered. Used by console queue views and the Compliance Register
   *  Export. */
  findAllAsOf(asOfDate: string, filters?: Partial<TNode>): Promise<TNode[]>;
}

export abstract class BaseRepository<TNode extends Bitemporal, TIdField extends keyof TNode>
  implements GraphRepository<TNode, TIdField>
{
  abstract readonly label: string;
  abstract readonly idField: TIdField;

  constructor(protected readonly driver: Driver) {}

  protected openSession(): Session {
    return this.driver.session({ database: getSingletonDatabase() });
  }

  /** Field names on TNode that are legitimately `T | null` and therefore
   *  need backfilling to `null` when the underlying Neo4j property is
   *  absent (see serialize.ts's doc comment for why). Every bitemporal
   *  label has `valid_to`; subclasses with additional nullable fields
   *  (`Obligation.penalty_ref`, `Circular.supersedes_circular_id`,
   *  `HumanReview.rationale`) override and extend this list. */
  protected get nullableFields(): readonly string[] {
    return ["valid_to"];
  }

  /** The single place every repository turns a raw Neo4j node-properties
   *  bag into its typed TNode — always routes through serializeProperties
   *  with this repository's nullableFields, so no call site can
   *  accidentally forget the null-backfill and reintroduce the
   *  undefined-vs-null bug. */
  protected deserialize(properties: Record<string, unknown>): TNode {
    return serializeProperties<TNode>(properties, this.nullableFields);
  }

  /** Strips recorded_at (defense in depth against a caller bypassing the
   *  CreateInput<T> compile-time guard via `as any`) and returns a plain
   *  params object safe to interpolate into a `SET n = $props`-style
   *  Cypher fragment. FR-9. */
  protected toCreateParams(input: CreateInput<TNode>): Record<string, unknown> {
    const params: Record<string, unknown> = { ...input };
    delete params.recorded_at;
    return params;
  }

  /** The standard single-statement CREATE pattern every bitemporal
   *  repository's create() uses (CircularRepository.create() is the one
   *  exception — it MERGEs on source_hash instead, but applies the same
   *  date()-wrapping below for the same reason).
   *
   *  `n = $props` alone would store `valid_from`/`valid_to` as plain
   *  Neo4j *strings* (whatever JS type the driver serializes a JS string
   *  parameter to), not the native Date type `pointInTimeWhereClause`'s
   *  `date($param)` comparisons require — comparing a String property to
   *  a Date-typed literal in Cypher evaluates to `null` (never true),
   *  which silently makes every "as of" query return zero rows. This was
   *  found by actually running seed + a point-in-time query against a
   *  real Neo4j 5.23 instance; no mocked-driver unit test can catch it,
   *  since the mock never enforces Cypher's real type-comparison
   *  semantics. The explicit `SET n.valid_from = date(...)` /
   *  `n.valid_to = CASE ... END` lines below run *after* `n = $props` in
   *  the same SET clause, so they win and overwrite the string versions
   *  with proper Date values. */
  protected buildCreateCypher(): string {
    return `CREATE (n:${this.label})
      SET n = $props,
          n.valid_from = date($props.valid_from),
          n.valid_to = CASE WHEN $props.valid_to IS NULL THEN null ELSE date($props.valid_to) END,
          n.recorded_at = datetime()
      RETURN n`;
  }

  abstract create(input: CreateInput<TNode>, tx?: ManagedTransaction): Promise<TNode>;

  /** Runs `work` inside the given transaction if one was passed in
   *  (i.e. this call is part of a larger commit, e.g. from
   *  GraphWriter.commitProposal), otherwise opens its own session and a
   *  fresh managed write transaction. Every repository's `create` and
   *  `supersede` use this so standalone calls and GraphWriter-driven
   *  calls share identical Cypher. */
  protected async withWrite<T>(
    tx: ManagedTransaction | undefined,
    work: (tx: ManagedTransaction) => Promise<T>
  ): Promise<T> {
    if (tx) {
      return work(tx);
    }
    const session = this.openSession();
    try {
      return await session.executeWrite((innerTx) => work(innerTx));
    } finally {
      await session.close();
    }
  }

  async findById(id: TNode[TIdField] & string): Promise<TNode | null> {
    const start = Date.now();
    const session = this.openSession();
    try {
      const result = await session.executeRead((tx) =>
        tx.run(`MATCH (n:${this.label} {${String(this.idField)}: $id}) RETURN n`, { id })
      );
      const record = result.records[0];
      const value = record ? this.deserialize(record.get("n").properties) : null;
      logOperation({ operation: "findById", label: this.label, durationMs: Date.now() - start, outcome: "success" });
      return value;
    } catch (error) {
      logOperation({ operation: "findById", label: this.label, durationMs: Date.now() - start, outcome: "error" });
      throw error;
    } finally {
      await session.close();
    }
  }

  async findAsOf(id: TNode[TIdField] & string, asOfDate: string): Promise<TNode | null> {
    const start = Date.now();
    const session = this.openSession();
    try {
      const cypher =
        `MATCH (n:${this.label} {${String(this.idField)}: $id}) ` +
        `WHERE ${pointInTimeWhereClause("n", "asOfDate")} RETURN n`;
      const result = await session.executeRead((tx) => tx.run(cypher, { id, asOfDate }));
      const record = result.records[0];
      const value = record ? this.deserialize(record.get("n").properties) : null;
      logOperation({ operation: "findAsOf", label: this.label, durationMs: Date.now() - start, outcome: "success" });
      return value;
    } catch (error) {
      logOperation({ operation: "findAsOf", label: this.label, durationMs: Date.now() - start, outcome: "error" });
      throw error;
    } finally {
      await session.close();
    }
  }

  async findAllAsOf(asOfDate: string, filters?: Partial<TNode>): Promise<TNode[]> {
    const start = Date.now();
    const session = this.openSession();
    try {
      const filterEntries = Object.entries(filters ?? {}).filter(([, value]) => value !== undefined);
      const params: Record<string, unknown> = { asOfDate };
      const filterClauses = filterEntries.map(([key, value], index) => {
        const paramName = `filter${index}`;
        params[paramName] = value;
        return `n.${key} = $${paramName}`;
      });
      const whereClauses = [pointInTimeWhereClause("n", "asOfDate"), ...filterClauses];
      const cypher = `MATCH (n:${this.label}) WHERE ${whereClauses.join(" AND ")} RETURN n`;
      const result = await session.executeRead((tx) => tx.run(cypher, params));
      const values = result.records.map((record) => this.deserialize(record.get("n").properties));
      logOperation({ operation: "findAllAsOf", label: this.label, durationMs: Date.now() - start, outcome: "success" });
      return values;
    } catch (error) {
      logOperation({ operation: "findAllAsOf", label: this.label, durationMs: Date.now() - start, outcome: "error" });
      throw error;
    } finally {
      await session.close();
    }
  }
}
