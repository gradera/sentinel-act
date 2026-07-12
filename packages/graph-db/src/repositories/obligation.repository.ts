// ObligationRepository — the hub type of the graph (§5.4). Highest-risk
// repository in the package: supersede() is the write path every
// regulatory amendment goes through, findLive() is what the risk scorer
// checks `overwritesLiveObligation` against, and findLineage() backs the
// console's LineageBreadcrumb.
import type { ManagedTransaction } from "neo4j-driver";
import type { Obligation } from "@sentinel-act/graph-schema";
import type { CreateInput } from "../types.js";
import { ConflictError } from "../errors.js";
import { logOperation } from "../logger.js";
import { BaseRepository } from "./base.repository.js";

export class ObligationRepository extends BaseRepository<Obligation, "obligation_id"> {
  readonly label = "Obligation";
  readonly idField = "obligation_id" as const;

  protected override get nullableFields(): readonly string[] {
    return [...super.nullableFields, "penalty_ref"];
  }

  async create(input: CreateInput<Obligation>, tx?: ManagedTransaction): Promise<Obligation> {
    const start = Date.now();
    const props = this.toCreateParams(input);
    try {
      const record = await this.withWrite(tx, async (innerTx) => {
        const result = await innerTx.run(this.buildCreateCypher(), { props });
        return result.records[0];
      });
      const value = this.deserialize(record.get("n").properties);
      logOperation({ operation: "create", label: this.label, durationMs: Date.now() - start, outcome: "success" });
      return value;
    } catch (error) {
      logOperation({ operation: "create", label: this.label, durationMs: Date.now() - start, outcome: "error" });
      throw error;
    }
  }

  /** All obligations currently valid (valid_to IS NULL) — the "live
   *  obligation set" the risk scorer checks overwritesLiveObligation
   *  against (context file §3 formula). */
  async findLive(filters?: { category?: string; intermediaryCategoryName?: string }): Promise<Obligation[]> {
    const start = Date.now();
    const session = this.openSession();
    try {
      const params: Record<string, unknown> = {};
      let matchClause = "MATCH (o:Obligation)";
      const whereClauses = ["o.valid_to IS NULL"];

      if (filters?.category) {
        whereClauses.push("o.category = $category");
        params.category = filters.category;
      }
      if (filters?.intermediaryCategoryName) {
        matchClause += "-[:APPLIES_TO]->(:IntermediaryCategory {name: $intermediaryCategoryName})";
        params.intermediaryCategoryName = filters.intermediaryCategoryName;
      }

      const cypher = `${matchClause} WHERE ${whereClauses.join(" AND ")} RETURN DISTINCT o`;
      const result = await session.executeRead((tx) => tx.run(cypher, params));
      const values = result.records.map((record) => this.deserialize(record.get("o").properties));
      logOperation({ operation: "findLive", label: this.label, durationMs: Date.now() - start, outcome: "success" });
      return values;
    } catch (error) {
      logOperation({ operation: "findLive", label: this.label, durationMs: Date.now() - start, outcome: "error" });
      throw error;
    } finally {
      await session.close();
    }
  }

  /** FR-10's exact 5-step supersede write pattern, scoped to Obligation.
   *
   *  Lock-forcing note (post-review correction): the original
   *  implementation used `SET old.valid_to = old.valid_to` — a
   *  self-assignment intended to force Neo4j to take a write lock on
   *  `old` before the `WHERE old.valid_to IS NULL` guard runs, so a
   *  transaction that blocks on that lock re-reads a fresh (post-commit)
   *  `valid_to` once unblocked. Running the real concurrent-supersede
   *  integration test against a live Neo4j 5.23 instance showed this does
   *  NOT reliably work — two concurrent supersede() calls on the same
   *  obligation both succeeded, which should be impossible under FR-14.
   *  The most likely explanation: a same-value self-assignment can be
   *  elided by Neo4j's query planner/runtime as a no-op, meaning no real
   *  write (and therefore no real lock) ever happens. `_concurrency_touch
   *  = datetime()` is a value that is, by construction, never the same
   *  twice, so it cannot be optimized away this way. This fix could not
   *  be verified end-to-end in the environment that wrote it (no local
   *  Neo4j access) — re-run
   *  `pnpm --filter @sentinel-act/graph-db test:integration` against a
   *  real instance to confirm concurrent-supersede.integration.test.ts
   *  actually passes now; if it doesn't, this needs a different
   *  mechanism (e.g. an explicit uniqueness-constrained "supersession
   *  lock" node, which is guaranteed atomic in Neo4j — see
   *  serialize.ts/base.repository.ts's other real-Neo4j-only bugs for the
   *  same "mocked tests can't catch this" caveat).
   *
   *  FR-11: does NOT copy the old obligation's outgoing structural edges
   *  onto the new node — the caller supplies the new node's edges
   *  explicitly via CommitPlan.edges. */
  async supersede(params: {
    oldObligationId: string;
    newObligation: CreateInput<Obligation>;
    effectiveDate: string;
    tx?: ManagedTransaction;
  }): Promise<{ old: Obligation; created: Obligation }> {
    const start = Date.now();
    try {
      const result = await this.withWrite(params.tx, async (tx) => {
        const newProps = this.toCreateParams(params.newObligation);
        const guarded = await tx.run(
          `MATCH (old:Obligation {obligation_id: $oldObligationId})
           SET old._concurrency_touch = datetime()
           WITH old
           WHERE old.valid_to IS NULL
           SET old.valid_to = date($effectiveDate)
           WITH old
           CREATE (new:Obligation)
           SET new = $newProps,
               new.valid_from = date($effectiveDate),
               new.valid_to = null,
               new.recorded_at = datetime()
           CREATE (new)-[:SUPERSEDES]->(old)
           RETURN old, new`,
          { oldObligationId: params.oldObligationId, effectiveDate: params.effectiveDate, newProps }
        );

        if (guarded.records.length === 0) {
          const existing = await tx.run(
            `MATCH (old:Obligation {obligation_id: $oldObligationId}) RETURN old.valid_to AS valid_to`,
            { oldObligationId: params.oldObligationId }
          );
          if (existing.records.length === 0) {
            throw new ConflictError(`Obligation ${params.oldObligationId} does not exist — cannot supersede.`);
          }
          throw new ConflictError(
            `Obligation ${params.oldObligationId} is already superseded (valid_to is already set) — cannot supersede again.`
          );
        }

        const record = guarded.records[0];
        return {
          old: this.deserialize(record.get("old").properties),
          created: this.deserialize(record.get("new").properties)
        };
      });
      logOperation({ operation: "supersede", label: this.label, durationMs: Date.now() - start, outcome: "success" });
      return result;
    } catch (error) {
      logOperation({ operation: "supersede", label: this.label, durationMs: Date.now() - start, outcome: "error" });
      throw error;
    }
  }

  /** All obligations that historically superseded, or were superseded
   *  by, the given obligation — the full lineage chain, for
   *  LineageBreadcrumb. Includes the obligation itself. */
  async findLineage(obligationId: string): Promise<Obligation[]> {
    const start = Date.now();
    const session = this.openSession();
    try {
      const cypher = `
        MATCH (o:Obligation {obligation_id: $obligationId})
        CALL {
          WITH o
          MATCH (o)-[:SUPERSEDES*0..]->(older:Obligation)
          RETURN older AS n
          UNION
          WITH o
          MATCH (newer:Obligation)-[:SUPERSEDES*0..]->(o)
          RETURN newer AS n
        }
        RETURN DISTINCT n
      `;
      const result = await session.executeRead((tx) => tx.run(cypher, { obligationId }));
      const values = result.records.map((record) => this.deserialize(record.get("n").properties));
      logOperation({ operation: "findLineage", label: this.label, durationMs: Date.now() - start, outcome: "success" });
      return values;
    } catch (error) {
      logOperation({ operation: "findLineage", label: this.label, durationMs: Date.now() - start, outcome: "error" });
      throw error;
    } finally {
      await session.close();
    }
  }
}
