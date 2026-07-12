// obligation.repository.test.ts (spec §10): the highest-risk repository —
// create() never leaks a client-supplied recorded_at, supersede() issues
// FR-10's exact four-step sequence in one transaction and throws
// ConflictError on a zero-row guarded match, findLive() filters on
// valid_to IS NULL, findLineage() walks SUPERSEDES both directions.
import { describe, expect, it } from "vitest";
import { ObligationRepository } from "../../src/repositories/obligation.repository.js";
import { ConflictError } from "../../src/errors.js";
import { createMockDriver, mockRecord } from "../helpers/mock-driver.js";
import type { Obligation } from "@sentinel-act/graph-schema";

const baseObligation: Omit<Obligation, "recorded_at"> = {
  obligation_id: "ob-1",
  derived_from_clause_id: "cl-1",
  category: "disclosure",
  requirement_text: "req",
  trigger_event: "trigger",
  deadline_rule: "T+5",
  responsible_role: "Compliance Officer",
  evidence_required: "log",
  penalty_ref: null,
  confidence_score: 0.9,
  grounding_score: 0.9,
  status: "proposed",
  valid_from: "2026-01-01",
  valid_to: null
};

describe("ObligationRepository.create", () => {
  it("never includes a client-supplied recorded_at in the Cypher params", async () => {
    const { driver, calls } = createMockDriver(() => ({
      records: [mockRecord({ n: { properties: { ...baseObligation, recorded_at: "2026-01-01T00:00:00Z" } } })]
    }));
    const repo = new ObligationRepository(driver);

    // Simulates a caller bypassing the CreateInput<T> compile-time guard
    // (e.g. via `as any`) to smuggle a client-supplied recorded_at through
    // — toCreateParams()'s runtime `delete params.recorded_at` must still
    // strip it (defense in depth, see base.repository.ts).
    const smuggled = { ...baseObligation, recorded_at: "2099-01-01T00:00:00Z" } as unknown as Obligation;
    await repo.create(smuggled);

    expect(calls).toHaveLength(1);
    expect(calls[0].params).not.toHaveProperty("props.recorded_at");
    const props = calls[0].params.props as Record<string, unknown>;
    expect(props.recorded_at).toBeUndefined();
    expect(calls[0].cypher).toContain("n.recorded_at = datetime()");
    // Regression: valid_from/valid_to must be explicitly date()-wrapped
    // (see base.repository.ts's buildCreateCypher() doc comment) — a
    // plain `n = $props` alone stores them as strings, which silently
    // breaks every point-in-time query against the created node. Found
    // running this against a real Neo4j 5.23 instance.
    expect(calls[0].cypher).toContain("n.valid_from = date($props.valid_from)");
    expect(calls[0].cypher).toContain("date($props.valid_to)");
  });
});

describe("ObligationRepository.supersede", () => {
  it("issues the FR-10 four-step sequence inside exactly one transaction", async () => {
    const { driver, calls, executeWriteCallCount } = createMockDriver(() => ({
      records: [
        mockRecord({
          old: { properties: { ...baseObligation, valid_to: "2026-07-03" } },
          new: { properties: { ...baseObligation, obligation_id: "ob-2", valid_from: "2026-07-03", valid_to: null } }
        })
      ]
    }));
    const repo = new ObligationRepository(driver);

    const result = await repo.supersede({
      oldObligationId: "ob-1",
      newObligation: { ...baseObligation, obligation_id: "ob-2", valid_from: "2026-07-03" },
      effectiveDate: "2026-07-03"
    });

    expect(executeWriteCallCount()).toBe(1);
    expect(calls).toHaveLength(1);
    const cypher = calls[0].cypher;
    expect(cypher).toContain("MATCH (old:Obligation {obligation_id: $oldObligationId})");
    // Regression: the lock-forcing write must be a guaranteed-mutating
    // one (`_concurrency_touch = datetime()`), not the original
    // self-assignment (`old.valid_to = old.valid_to`) — a real Neo4j 5.23
    // instance showed the self-assignment does not reliably force a
    // write lock (two concurrent supersede() calls both succeeded, which
    // must be impossible under FR-14). See obligation.repository.ts's
    // supersede() doc comment for the full story.
    expect(cypher).toContain("SET old._concurrency_touch = datetime()");
    expect(cypher).not.toContain("old.valid_to = old.valid_to");
    expect(cypher).toContain("WHERE old.valid_to IS NULL");
    expect(cypher).toContain("SET old.valid_to = date($effectiveDate)");
    expect(cypher).toContain("CREATE (new:Obligation)");
    expect(cypher).toContain("CREATE (new)-[:SUPERSEDES]->(old)");
    expect(cypher).toContain("RETURN old, new");
    expect(result.old.valid_to).toBe("2026-07-03");
    expect(result.created.obligation_id).toBe("ob-2");
  });

  it("throws ConflictError when the guarded MATCH returns zero rows (id does not exist)", async () => {
    const { driver } = createMockDriver(() => ({ records: [] }));
    const repo = new ObligationRepository(driver);

    await expect(
      repo.supersede({
        oldObligationId: "does-not-exist",
        newObligation: { ...baseObligation, obligation_id: "ob-2" },
        effectiveDate: "2026-07-03"
      })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("throws ConflictError when the guarded MATCH returns zero rows (already superseded)", async () => {
    let callIndex = 0;
    const { driver } = createMockDriver((_cypher) => {
      callIndex += 1;
      // First call: the guarded supersede MATCH — zero rows (already closed).
      if (callIndex === 1) return { records: [] };
      // Second call: the disambiguating existence check — one row, with a
      // non-null valid_to, to distinguish "already superseded" from "not found".
      return { records: [mockRecord({ valid_to: "2026-06-01" })] };
    });
    const repo = new ObligationRepository(driver);

    await expect(
      repo.supersede({
        oldObligationId: "ob-already-closed",
        newObligation: { ...baseObligation, obligation_id: "ob-2" },
        effectiveDate: "2026-07-03"
      })
    ).rejects.toThrow(/already superseded/);
  });
});

describe("ObligationRepository.findLive", () => {
  it("filters by valid_to IS NULL", async () => {
    const { driver, calls } = createMockDriver(() => ({ records: [] }));
    const repo = new ObligationRepository(driver);

    await repo.findLive();

    expect(calls).toHaveLength(1);
    expect(calls[0].cypher).toContain("o.valid_to IS NULL");
  });

  it("adds an APPLIES_TO/IntermediaryCategory match when intermediaryCategoryName is given", async () => {
    const { driver, calls } = createMockDriver(() => ({ records: [] }));
    const repo = new ObligationRepository(driver);

    await repo.findLive({ intermediaryCategoryName: "Stockbroker" });

    expect(calls[0].cypher).toContain("[:APPLIES_TO]->(:IntermediaryCategory {name: $intermediaryCategoryName})");
    expect(calls[0].params.intermediaryCategoryName).toBe("Stockbroker");
  });
});

describe("ObligationRepository.findLineage", () => {
  it("walks SUPERSEDES in both directions", async () => {
    const { driver, calls } = createMockDriver(() => ({ records: [] }));
    const repo = new ObligationRepository(driver);

    await repo.findLineage("ob-1");

    const cypher = calls[0].cypher;
    expect(cypher).toContain("MATCH (o)-[:SUPERSEDES*0..]->(older:Obligation)");
    expect(cypher).toContain("MATCH (newer:Obligation)-[:SUPERSEDES*0..]->(o)");
    expect(cypher).toContain("UNION");
    expect(calls[0].params).toEqual({ obligationId: "ob-1" });
  });
});
