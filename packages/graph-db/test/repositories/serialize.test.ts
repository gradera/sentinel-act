// serialize.test.ts: regression coverage for two real-Neo4j-only bugs
// found running this package against a live Neo4j 5.23 instance (a
// mocked driver can't reproduce Neo4j's actual null-elision behavior, but
// it CAN verify this pure-JS backfill logic once we know what to backfill
// for).
//
// 1. Neo4j elides (does not store) a property whose value is null — a
//    node created with `penalty_ref: null` comes back from the driver
//    with no `penalty_ref` key in `properties` at all. serializeProperties
//    must backfill `null` for any caller-declared nullableFields that are
//    absent, so the graph-schema `string | null` contract round-trips
//    correctly instead of silently becoming `undefined`.
// 2. `_`-prefixed properties (internal locking markers like
//    `_concurrency_touch`, see obligation.repository.ts) must never leak
//    into a returned domain object.
import { describe, expect, it } from "vitest";
import { serializeProperties } from "../../src/repositories/serialize.js";

describe("serializeProperties", () => {
  it("backfills null for declared nullableFields that are absent from the raw properties", () => {
    const result = serializeProperties<{ obligation_id: string; penalty_ref: string | null; valid_to: string | null }>(
      { obligation_id: "ob-1" },
      ["penalty_ref", "valid_to"]
    );

    expect(result.penalty_ref).toBeNull();
    expect(result.valid_to).toBeNull();
    expect(result.obligation_id).toBe("ob-1");
  });

  it("does not override a present value for a declared nullableField", () => {
    const result = serializeProperties<{ valid_to: string | null }>({ valid_to: "2026-07-03" }, ["valid_to"]);
    expect(result.valid_to).toBe("2026-07-03");
  });

  it("does not backfill fields that were not declared nullable", () => {
    const result = serializeProperties<{ obligation_id?: string }>({}, []);
    expect(result.obligation_id).toBeUndefined();
    expect("obligation_id" in result).toBe(false);
  });

  it("strips `_`-prefixed internal properties (e.g. locking markers) from the returned object", () => {
    const result = serializeProperties<{ obligation_id: string }>({
      obligation_id: "ob-1",
      _concurrency_touch: "2026-07-03T00:00:00Z"
    });

    expect(result.obligation_id).toBe("ob-1");
    expect("_concurrency_touch" in result).toBe(false);
  });
});
