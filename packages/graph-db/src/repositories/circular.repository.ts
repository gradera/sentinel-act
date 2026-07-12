// CircularRepository — the anchor node for every downstream fact.
// create() dedupes on Circular.source_hash (FR-1, §8 duplicate-event
// row) so a redelivered/overlapping Regulatory Watch poll never creates
// two Circular nodes for identical source text. supersede() implements
// the exact FR-10 write pattern.
import type { ManagedTransaction } from "neo4j-driver";
import type { Circular } from "@sentinel-act/graph-schema";
import type { CreateInput } from "../types.js";
import { ConflictError } from "../errors.js";
import { logOperation } from "../logger.js";
import { BaseRepository } from "./base.repository.js";

export class CircularRepository extends BaseRepository<Circular, "circular_id"> {
  readonly label = "Circular";
  readonly idField = "circular_id" as const;

  protected override get nullableFields(): readonly string[] {
    return [...super.nullableFields, "supersedes_circular_id"];
  }

  /** MERGE keyed on source_hash (not circular_id) — see FR-1/§8: two
   *  overlapping Watch polls that hash the same source text must never
   *  create two Circular nodes. On an existing match, this is a no-op
   *  (properties are not overwritten) and the already-persisted node is
   *  returned.
   *
   *  Bespoke (not BaseRepository.buildCreateCypher()) because MERGE needs
   *  a different top-level shape than CREATE — but applies the identical
   *  date()-wrapping fix (see buildCreateCypher()'s doc comment): without
   *  it, `valid_from`/`valid_to` would be stored as plain strings and
   *  every point-in-time query against a Circular would silently return
   *  nothing (found running this against a real Neo4j instance). */
  async create(input: CreateInput<Circular>, tx?: ManagedTransaction): Promise<Circular> {
    const start = Date.now();
    const props = this.toCreateParams(input);
    try {
      const record = await this.withWrite(tx, async (innerTx) => {
        const result = await innerTx.run(
          `MERGE (n:Circular {source_hash: $source_hash})
           ON CREATE SET n = $props,
               n.valid_from = date($props.valid_from),
               n.valid_to = CASE WHEN $props.valid_to IS NULL THEN null ELSE date($props.valid_to) END,
               n.recorded_at = datetime()
           RETURN n`,
          { source_hash: props.source_hash, props }
        );
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

  /** FR-10's exact 5-step supersede write pattern, scoped to Circular.
   *  See obligation.repository.ts's supersede() for the full rationale
   *  behind `_concurrency_touch` (post-review correction — the original
   *  `SET old.valid_to = old.valid_to` no-op did not reliably force a
   *  write lock in a real Neo4j 5.23 instance; unverified whether the
   *  replacement fully resolves it, since this repository's own
   *  concurrent-supersede behavior was only exercised via
   *  ObligationRepository in the integration test suite — re-verify
   *  against real Neo4j before trusting this under concurrent load). */
  async supersede(params: {
    oldCircularId: string;
    newCircular: CreateInput<Circular>;
    effectiveDate: string;
    tx?: ManagedTransaction;
  }): Promise<{ old: Circular; created: Circular }> {
    const start = Date.now();
    try {
      const result = await this.withWrite(params.tx, async (tx) => {
        const newProps = this.toCreateParams(params.newCircular);
        const guarded = await tx.run(
          `MATCH (old:Circular {circular_id: $oldCircularId})
           SET old._concurrency_touch = datetime()
           WITH old
           WHERE old.valid_to IS NULL
           SET old.valid_to = date($effectiveDate)
           WITH old
           CREATE (new:Circular)
           SET new = $newProps,
               new.valid_from = date($effectiveDate),
               new.valid_to = null,
               new.recorded_at = datetime()
           CREATE (new)-[:SUPERSEDES]->(old)
           RETURN old, new`,
          { oldCircularId: params.oldCircularId, effectiveDate: params.effectiveDate, newProps }
        );

        if (guarded.records.length === 0) {
          const existing = await tx.run(
            `MATCH (old:Circular {circular_id: $oldCircularId}) RETURN old.valid_to AS valid_to`,
            { oldCircularId: params.oldCircularId }
          );
          if (existing.records.length === 0) {
            throw new ConflictError(`Circular ${params.oldCircularId} does not exist — cannot supersede.`);
          }
          throw new ConflictError(
            `Circular ${params.oldCircularId} is already superseded (valid_to is already set) — cannot supersede again.`
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
}
