// circular.repository.test.ts (spec §10): same supersede contract as
// ObligationRepository, plus CircularRepository.create's source_hash MERGE
// dedup (FR-1 / §8 duplicate-event row).
import { describe, expect, it } from "vitest";
import { CircularRepository } from "../../src/repositories/circular.repository.js";
import { ConflictError } from "../../src/errors.js";
import { createMockDriver, mockRecord } from "../helpers/mock-driver.js";
import type { Circular } from "@sentinel-act/graph-schema";

const baseCircular: Omit<Circular, "recorded_at"> = {
  circular_id: "cir-1",
  title: "Master Circular",
  type: "master_circular",
  category: "market_intermediaries",
  date_issued: "2026-01-01",
  date_effective: "2026-01-10",
  source_hash: "hash-1",
  supersedes_circular_id: null,
  valid_from: "2026-01-10",
  valid_to: null
};

describe("CircularRepository.create", () => {
  it("MERGEs on source_hash (not circular_id) so overlapping Watch polls never duplicate", async () => {
    const { driver, calls } = createMockDriver(() => ({
      records: [mockRecord({ n: { properties: { ...baseCircular, recorded_at: "2026-01-10T00:00:00Z" } } })]
    }));
    const repo = new CircularRepository(driver);

    await repo.create(baseCircular);

    expect(calls).toHaveLength(1);
    expect(calls[0].cypher).toContain("MERGE (n:Circular {source_hash: $source_hash})");
    expect(calls[0].cypher).toContain("ON CREATE SET n = $props");
    expect(calls[0].cypher).toContain("n.recorded_at = datetime()");
    // Regression: valid_from/valid_to must be explicitly date()-wrapped,
    // not left as the plain strings `n = $props` alone would store them
    // as — a real Neo4j instance silently returns zero rows for every
    // point-in-time query against a node created without this (found by
    // actually running the seed fixtures + a point-in-time query against
    // Neo4j 5.23; a mocked driver can't catch this class of bug at all).
    expect(calls[0].cypher).toContain("n.valid_from = date($props.valid_from)");
    expect(calls[0].cypher).toContain("date($props.valid_to)");
    expect(calls[0].params.source_hash).toBe("hash-1");
  });

  it("never includes a client-supplied recorded_at in the Cypher params", async () => {
    const { driver, calls } = createMockDriver(() => ({
      records: [mockRecord({ n: { properties: baseCircular } })]
    }));
    const repo = new CircularRepository(driver);

    await repo.create(baseCircular);

    const props = calls[0].params.props as Record<string, unknown>;
    expect(props.recorded_at).toBeUndefined();
  });
});

describe("CircularRepository.supersede", () => {
  it("issues the FR-10 four-step sequence inside exactly one transaction", async () => {
    const { driver, calls, executeWriteCallCount } = createMockDriver(() => ({
      records: [
        mockRecord({
          old: { properties: { ...baseCircular, valid_to: "2026-07-03" } },
          new: {
            properties: {
              ...baseCircular,
              circular_id: "cir-2",
              source_hash: "hash-2",
              supersedes_circular_id: "cir-1",
              valid_from: "2026-07-03",
              valid_to: null
            }
          }
        })
      ]
    }));
    const repo = new CircularRepository(driver);

    const result = await repo.supersede({
      oldCircularId: "cir-1",
      newCircular: { ...baseCircular, circular_id: "cir-2", source_hash: "hash-2", supersedes_circular_id: "cir-1" },
      effectiveDate: "2026-07-03"
    });

    expect(executeWriteCallCount()).toBe(1);
    expect(calls).toHaveLength(1);
    const cypher = calls[0].cypher;
    expect(cypher).toContain("MATCH (old:Circular {circular_id: $oldCircularId})");
    // Regression — see obligation.repository.test.ts's identical check:
    // the lock-forcing write must be guaranteed-mutating, not a same-value
    // self-assignment (which a real Neo4j 5.23 instance showed does not
    // reliably force a write lock).
    expect(cypher).toContain("SET old._concurrency_touch = datetime()");
    expect(cypher).not.toContain("old.valid_to = old.valid_to");
    expect(cypher).toContain("WHERE old.valid_to IS NULL");
    expect(cypher).toContain("SET old.valid_to = date($effectiveDate)");
    expect(cypher).toContain("CREATE (new:Circular)");
    expect(cypher).toContain("CREATE (new)-[:SUPERSEDES]->(old)");
    expect(result.old.valid_to).toBe("2026-07-03");
    expect(result.created.circular_id).toBe("cir-2");
  });

  it("throws ConflictError when the guarded MATCH returns zero rows", async () => {
    const { driver } = createMockDriver(() => ({ records: [] }));
    const repo = new CircularRepository(driver);

    await expect(
      repo.supersede({
        oldCircularId: "missing",
        newCircular: { ...baseCircular, circular_id: "cir-2", source_hash: "hash-2" },
        effectiveDate: "2026-07-03"
      })
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
