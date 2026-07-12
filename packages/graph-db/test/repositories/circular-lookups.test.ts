// circular-lookups.test.ts — Spec 02's Watch-agent read surface
// (findCircularBySourceHash, findCircularsByTitleFuzzy, titleSimilarity).
// See src/repositories/circular-lookups.ts's doc comment for why the
// fuzzy-scoring boundary is designed the way it is.
import { describe, expect, it } from "vitest";
import { findCircularBySourceHash, findCircularsByTitleFuzzy, titleSimilarity } from "../../src/repositories/circular-lookups.js";
import { createMockDriver, mockRecord } from "../helpers/mock-driver.js";
import type { Circular } from "@sentinel-act/graph-schema";

const baseCircular: Circular = {
  circular_id: "cir-1",
  title: "Master Circular for Stock Brokers",
  type: "master_circular",
  category: "Stockbroker",
  date_issued: "2023-06-12",
  date_effective: "2023-06-12",
  source_hash: "hash-1",
  supersedes_circular_id: null,
  valid_from: "2023-06-12",
  valid_to: null,
  recorded_at: "2023-06-12T00:00:00Z"
};

describe("findCircularBySourceHash", () => {
  it("issues the spec §4 documented Cypher shape and returns null on no match", async () => {
    const { driver, calls } = createMockDriver(() => ({ records: [] }));

    const result = await findCircularBySourceHash("does-not-exist", driver);

    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].cypher).toContain("MATCH (c:Circular {source_hash: $hash}) RETURN c LIMIT 1");
    expect(calls[0].params.hash).toBe("does-not-exist");
  });

  it("returns the deserialized Circular on a match", async () => {
    const { driver } = createMockDriver(() => ({ records: [mockRecord({ c: { properties: baseCircular } })] }));

    const result = await findCircularBySourceHash("hash-1", driver);

    expect(result?.circular_id).toBe("cir-1");
    expect(result?.supersedes_circular_id).toBeNull();
  });
});

describe("findCircularsByTitleFuzzy", () => {
  it("pre-filters on category via Cypher, scores in application code, sorts descending by similarity", async () => {
    const closeMatch: Circular = { ...baseCircular, circular_id: "cir-close", title: "Master Circular for Stock Brokers" };
    const farMatch: Circular = { ...baseCircular, circular_id: "cir-far", title: "Circular on Depository Participant Norms" };

    const { driver, calls } = createMockDriver(() => ({
      records: [mockRecord({ c: { properties: farMatch } }), mockRecord({ c: { properties: closeMatch } })]
    }));

    const results = await findCircularsByTitleFuzzy("Master Circular for Stock Brokers", "Stockbroker", driver);

    expect(calls[0].cypher).toContain("MATCH (c:Circular {category: $category})");
    expect(calls[0].cypher).toContain("WHERE c.valid_to IS NULL");
    expect(calls[0].params.category).toBe("Stockbroker");
    // Sorted descending by similarity to the query title — the exact
    // match must come first regardless of the order Cypher returned rows.
    expect(results[0].circular_id).toBe("cir-close");
  });

  it("prunes results below the internal similarity floor", async () => {
    const totallyUnrelated: Circular = { ...baseCircular, circular_id: "cir-unrelated", title: "zzz qqq xyz completely different" };
    const { driver } = createMockDriver(() => ({ records: [mockRecord({ c: { properties: totallyUnrelated } })] }));

    const results = await findCircularsByTitleFuzzy("Master Circular for Stock Brokers", "Stockbroker", driver);

    expect(results).toEqual([]);
  });
});

describe("titleSimilarity", () => {
  it("returns 1 for identical titles", () => {
    expect(titleSimilarity("Master Circular for Stock Brokers", "Master Circular for Stock Brokers")).toBe(1);
  });

  it("is insensitive to case, punctuation, and word order", () => {
    expect(titleSimilarity("Master Circular for Stock Brokers", "stock brokers: master circular, for")).toBeGreaterThan(0.9);
  });

  it("scores unrelated titles low", () => {
    expect(titleSimilarity("Master Circular for Stock Brokers", "Depository Participant Grievance Redressal Norms")).toBeLessThan(0.5);
  });
});
