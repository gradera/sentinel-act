// Shared node-property serialization helper used by every repository.
// Neo4j returns driver-native temporal wrapper objects (neo4j.types.Date,
// DateTime, LocalDateTime, Integer) for any property written via
// date()/datetime() Cypher functions. @sentinel-act/graph-schema's TS
// interfaces declare those fields as plain ISO strings (or numbers for
// scores), so every repository converts driver records through this
// function before returning them to callers — no repository should hand
// a raw neo4j-driver temporal object back across this package's public
// API.
//
// Two behaviors here exist specifically because of bugs found running
// this package against a real Neo4j 5.23 instance (mocked-driver unit
// tests can't catch either):
//
// 1. Neo4j does not store a property whose value is `null` — `SET
//    n.valid_to = null` (or `SET n = $map` where `$map.valid_to` is
//    `null`) *removes* the property rather than storing a null-valued
//    one. So a node created with, say, `penalty_ref: null` comes back
//    from the driver with no `penalty_ref` key in `properties` at all —
//    `undefined`, not `null`, once naively spread into a JS object. Every
//    caller passes the set of field names on TNode that are legitimately
//    nullable (`nullableFields`) so this function can backfill `null`
//    for any of them that are absent, restoring the graph-schema
//    contract's `string | null` shape.
// 2. `_`-prefixed properties (e.g. `_concurrency_touch`, used by
//    supersede()'s locking pattern — see obligation.repository.ts) are
//    internal implementation details that must never leak into a
//    returned domain object; they're dropped here unconditionally.
import neo4j from "neo4j-driver";

export function serializeProperties<T>(properties: Record<string, unknown>, nullableFields: readonly string[] = []): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (key.startsWith("_")) continue;
    out[key] = serializeValue(value);
  }
  for (const field of nullableFields) {
    if (!(field in out)) {
      out[field] = null;
    }
  }
  return out as T;
}

function serializeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value ?? null;
  }
  if (neo4j.isDate(value) || neo4j.isDateTime(value) || neo4j.isLocalDateTime(value) || neo4j.isTime(value)) {
    return value.toString();
  }
  if (neo4j.isInt(value)) {
    return value.toNumber();
  }
  if (Array.isArray(value)) {
    return value.map(serializeValue);
  }
  return value;
}
