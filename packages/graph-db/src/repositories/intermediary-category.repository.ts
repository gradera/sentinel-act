// IntermediaryCategoryRepository. Deliberate deviation from the
// GraphRepository<TNode extends Bitemporal, ...> shape every other
// repository implements: IntermediaryCategory does NOT extend Bitemporal
// (spec §4.2 — categories are a static reference/lookup set, not a
// versioned fact, and carry no valid_from/valid_to/recorded_at fields at
// all). FR-7 says every repository implements "at minimum create,
// findById, findAsOf, findAllAsOf", but a findAsOf/findAllAsOf on a label
// with no valid_from/valid_to property is not meaningful — applying the
// §4.3 point-in-time predicate to this label would just throw a Cypher
// property-not-found style query, not degrade gracefully. This class
// therefore exposes create/findById/findAll (no bitemporal filtering)
// instead of the generic bitemporal contract, per spec §4.2's own
// authority over FR-7's general "at minimum" phrasing for this one
// label. Documented here rather than silently reconciled, matching how
// this spec's other genuine tensions (CommitPlan additive fields,
// Clause.embedding_ref typing) are handled elsewhere in this package.
import type { Driver, ManagedTransaction, Session } from "neo4j-driver";
import type { IntermediaryCategory } from "@sentinel-act/graph-schema";
import { getSingletonDatabase } from "../driver.js";
import { logOperation } from "../logger.js";
import { serializeProperties } from "./serialize.js";

export class IntermediaryCategoryRepository {
  readonly label = "IntermediaryCategory";
  readonly idField = "category_id" as const;

  constructor(private readonly driver: Driver) {}

  private openSession(): Session {
    return this.driver.session({ database: getSingletonDatabase() });
  }

  private async withWrite<T>(
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

  /** MERGE keyed on `name` (functionally unique per FR-1) so re-seeding
   *  the same category set is idempotent. */
  async create(input: IntermediaryCategory, tx?: ManagedTransaction): Promise<IntermediaryCategory> {
    const start = Date.now();
    try {
      const record = await this.withWrite(tx, async (innerTx) => {
        const result = await innerTx.run(
          `MERGE (n:IntermediaryCategory {name: $name})
           ON CREATE SET n.category_id = $category_id
           RETURN n`,
          { name: input.name, category_id: input.category_id }
        );
        return result.records[0];
      });
      const value = serializeProperties<IntermediaryCategory>(record.get("n").properties);
      logOperation({ operation: "create", label: this.label, durationMs: Date.now() - start, outcome: "success" });
      return value;
    } catch (error) {
      logOperation({ operation: "create", label: this.label, durationMs: Date.now() - start, outcome: "error" });
      throw error;
    }
  }

  async findById(categoryId: string): Promise<IntermediaryCategory | null> {
    const session = this.openSession();
    try {
      const result = await session.executeRead((tx) =>
        tx.run(`MATCH (n:IntermediaryCategory {category_id: $categoryId}) RETURN n`, { categoryId })
      );
      const record = result.records[0];
      return record ? serializeProperties<IntermediaryCategory>(record.get("n").properties) : null;
    } finally {
      await session.close();
    }
  }

  async findByName(name: string): Promise<IntermediaryCategory | null> {
    const session = this.openSession();
    try {
      const result = await session.executeRead((tx) =>
        tx.run(`MATCH (n:IntermediaryCategory {name: $name}) RETURN n`, { name })
      );
      const record = result.records[0];
      return record ? serializeProperties<IntermediaryCategory>(record.get("n").properties) : null;
    } finally {
      await session.close();
    }
  }

  async findAll(): Promise<IntermediaryCategory[]> {
    const session = this.openSession();
    try {
      const result = await session.executeRead((tx) => tx.run(`MATCH (n:IntermediaryCategory) RETURN n`));
      return result.records.map((record) => serializeProperties<IntermediaryCategory>(record.get("n").properties));
    } finally {
      await session.close();
    }
  }
}
