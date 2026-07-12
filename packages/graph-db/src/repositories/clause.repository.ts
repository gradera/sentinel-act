// ClauseRepository. Owns the embedding_ref serialize/deserialize
// boundary flagged in spec §13 open question #2 (see the block comment
// below) — this is the one place in the package where the TS `string`
// type on Clause.embedding_ref and the DB's native LIST<FLOAT> vector
// property meet.
import type { ManagedTransaction } from "neo4j-driver";
import type { Clause } from "@sentinel-act/graph-schema";
import type { CreateInput } from "../types.js";
import { logOperation } from "../logger.js";
import { BaseRepository } from "./base.repository.js";
import { serializeProperties } from "./serialize.js";

/**
 * embedding_ref boundary (spec §13 open question #2, resolved per its
 * recommended default): `@sentinel-act/graph-schema` types
 * `Clause.embedding_ref` as `string` — this repository treats that as
 * the *wire* representation, a JSON-stringified `number[]`. The Neo4j
 * property physically named `embedding_ref` on `:Clause` nodes instead
 * stores a native `LIST<FLOAT>` (required for `clause_embedding_index`,
 * see migrations/004_vector_index.cypher). This file is the single place
 * that boundary is crossed:
 *   - `toGraphEmbedding`: TS `string` -> `number[]` for Cypher params.
 *   - `fromGraphEmbedding`: Neo4j `LIST<FLOAT>` (surfaced by the driver
 *     as a plain JS `number[]`) -> JSON-stringified TS `string`.
 * Whoever implements Specs 03/04 (embedding generation) should call
 * `ClauseRepository.create`/pass `embedding_ref` as
 * `JSON.stringify(embeddingVector)` — this repository converts it before
 * it ever reaches Cypher, and converts it back on every read path so
 * every other caller in the codebase only ever sees the `string` shape
 * `graph-schema` declares.
 */
function toGraphEmbedding(embeddingRef: string): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(embeddingRef);
  } catch (error) {
    throw new Error("Clause.embedding_ref must be a JSON-stringified number[] array.", { cause: error });
  }
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "number")) {
    throw new Error("Clause.embedding_ref must be a JSON-stringified number[] array.");
  }
  return parsed;
}

/** Exported (not just used internally) because vector-search.ts crosses
 *  this exact same boundary when turning a `db.index.vector.queryNodes`
 *  hit back into a `Clause` — see that file. Keeping one implementation
 *  here, rather than a second copy in vector-search.ts, is the point of
 *  documenting this as "the single place this boundary is crossed". */
export function fromGraphEmbedding(vector: unknown): string {
  if (Array.isArray(vector)) {
    return JSON.stringify(vector);
  }
  // Embedding not yet generated for this clause (empty/absent vector).
  return JSON.stringify([]);
}

/** Field names on Clause that are legitimately nullable — kept in sync
 *  with ClauseRepository's own `nullableFields` getter, but declared
 *  separately since `deserializeClauseNode` is a standalone function (also
 *  called from vector-search.ts) rather than a repository method and has
 *  no `this` to read the getter from. */
const CLAUSE_NULLABLE_FIELDS = ["valid_to"] as const;

/** Turns a raw Neo4j node-properties bag (as returned by
 *  `record.get("node").properties` from any Clause-returning query,
 *  including vector-search.ts's `db.index.vector.queryNodes` call) into a
 *  well-typed `Clause`, crossing the embedding_ref boundary documented
 *  above. */
export function deserializeClauseNode(properties: Record<string, unknown>): Clause {
  return serializeProperties<Clause>(
    {
      ...properties,
      embedding_ref: fromGraphEmbedding(properties.embedding_ref)
    },
    CLAUSE_NULLABLE_FIELDS
  );
}

export class ClauseRepository extends BaseRepository<Clause, "clause_id"> {
  readonly label = "Clause";
  readonly idField = "clause_id" as const;

  protected override get nullableFields(): readonly string[] {
    return CLAUSE_NULLABLE_FIELDS;
  }

  /** Bespoke (not BaseRepository.buildCreateCypher()) because embedding_ref
   *  needs the toGraphEmbedding() conversion below — but applies the
   *  identical date()-wrapping fix documented on buildCreateCypher(): a
   *  plain `n = $props` alone stores valid_from/valid_to as strings, which
   *  silently breaks every point-in-time query against a Clause (found by
   *  actually running this against a real Neo4j 5.23 instance). */
  async create(input: CreateInput<Clause>, tx?: ManagedTransaction): Promise<Clause> {
    const start = Date.now();
    const props = this.toCreateParams(input);
    const embeddingRefRaw = props.embedding_ref;
    const graphEmbedding =
      typeof embeddingRefRaw === "string" && embeddingRefRaw.length > 0 ? toGraphEmbedding(embeddingRefRaw) : [];
    const cypherProps = { ...props, embedding_ref: graphEmbedding };
    try {
      const record = await this.withWrite(tx, async (innerTx) => {
        const result = await innerTx.run(
          `CREATE (n:Clause)
           SET n = $props,
               n.valid_from = date($props.valid_from),
               n.valid_to = CASE WHEN $props.valid_to IS NULL THEN null ELSE date($props.valid_to) END,
               n.recorded_at = datetime()
           RETURN n`,
          { props: cypherProps }
        );
        return result.records[0];
      });
      const rawProperties = record.get("n").properties as Record<string, unknown>;
      const value = this.deserialize({
        ...rawProperties,
        embedding_ref: fromGraphEmbedding(rawProperties.embedding_ref)
      });
      logOperation({ operation: "create", label: this.label, durationMs: Date.now() - start, outcome: "success" });
      return value;
    } catch (error) {
      logOperation({ operation: "create", label: this.label, durationMs: Date.now() - start, outcome: "error" });
      throw error;
    }
  }

  override async findById(id: string): Promise<Clause | null> {
    const clause = await super.findById(id);
    return clause ? this.withEmbeddingAsString(clause) : null;
  }

  override async findAsOf(id: string, asOfDate: string): Promise<Clause | null> {
    const clause = await super.findAsOf(id, asOfDate);
    return clause ? this.withEmbeddingAsString(clause) : null;
  }

  override async findAllAsOf(asOfDate: string, filters?: Partial<Clause>): Promise<Clause[]> {
    const clauses = await super.findAllAsOf(asOfDate, filters);
    return clauses.map((clause) => this.withEmbeddingAsString(clause));
  }

  private withEmbeddingAsString(clause: Clause): Clause {
    return { ...clause, embedding_ref: fromGraphEmbedding(clause.embedding_ref) };
  }
}
