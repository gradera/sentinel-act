// Shared bitemporal "as of" helpers used by every repository (§5.5).
// pointInTimeWhereClause is the single source of truth for the exact
// predicate shape from spec §4.3 — every "as of" query in this layer
// (repositories' findAsOf/findAllAsOf and findObligationsAsOf below)
// generates exactly this fragment against whichever node label/alias is
// being queried.
import type { Session } from "neo4j-driver";
import type { Obligation } from "@sentinel-act/graph-schema";
import type { PointInTimeQuery } from "./types.js";
import { serializeProperties } from "./repositories/serialize.js";

/**
 * Returns the exact bitemporal point-in-time WHERE fragment:
 * `${alias}.valid_from <= date($${dateParam}) AND (${alias}.valid_to IS NULL OR ${alias}.valid_to > date($${dateParam}))`
 *
 * `alias` is the Cypher variable bound to the node (e.g. "o", "n").
 * `dateParam` is the *name* of the query parameter holding the ISO date
 * string (the `$` is added by this function) — callers must bind that
 * parameter themselves when running the query.
 */
export function pointInTimeWhereClause(alias: string, dateParam: string): string {
  return `${alias}.valid_from <= date($${dateParam}) AND (${alias}.valid_to IS NULL OR ${alias}.valid_to > date($${dateParam}))`;
}

/**
 * Point-in-time query for the "live obligation set" filtered by
 * intermediary category and/or status — the exact shape of the canonical
 * query reproduced in context file §2 / spec §4.3, generalized with
 * optional filters per PointInTimeQuery.
 */
export async function findObligationsAsOf(
  session: Session,
  query: PointInTimeQuery
): Promise<Obligation[]> {
  const params: Record<string, unknown> = { asOfDate: query.asOfDate };
  let matchClause = "MATCH (o:Obligation)";

  if (query.categoryName) {
    matchClause += "-[:APPLIES_TO]->(:IntermediaryCategory {name: $categoryName})";
    params.categoryName = query.categoryName;
  }

  const whereClauses = [pointInTimeWhereClause("o", "asOfDate")];
  if (query.status) {
    whereClauses.push("o.status = $status");
    params.status = query.status;
  }

  const cypher = `${matchClause} WHERE ${whereClauses.join(" AND ")} RETURN o`;
  const result = await session.executeRead((tx) => tx.run(cypher, params));
  return result.records.map((record) => serializeProperties<Obligation>(record.get("o").properties));
}
