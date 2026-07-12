// Spec 02 §10 unit test: detectChangeType, table-driven over
// (existing-by-hash, existing-by-fuzzy-title, neither) -> (unchanged,
// amendment, new).
import { describe, expect, it } from "vitest";
import { detectChangeType, computeSourceHash, canonicalizeText } from "../regulatory-watch.agent.js";
import type { Circular } from "@sentinel-act/graph-schema";
import type { FetchedCircularPage, ListingEntry } from "../regulatory-watch.types.js";

function makeCircular(overrides: Partial<Circular> = {}): Circular {
  return {
    circular_id: "circ-existing-1",
    title: "SEBI Circular on Client Margin Reporting",
    type: "circular",
    category: "Stockbroker",
    date_issued: "2026-07-08",
    date_effective: "2026-07-08",
    source_hash: "existing-hash",
    supersedes_circular_id: null,
    valid_from: "2026-07-08",
    valid_to: null,
    recorded_at: "2026-07-08T00:00:00Z",
    ...overrides
  };
}

function makePage(overrides: Partial<FetchedCircularPage> = {}): FetchedCircularPage {
  const canonicalText = canonicalizeText("<html><body><div class=\"circular-body\"><p>1. Some obligation text.</p></div></body></html>");
  return {
    detailUrl: "https://www.sebi.gov.in/circulars/test.html",
    rawHtml: "<html></html>",
    canonicalText,
    sourceHash: computeSourceHash(canonicalText),
    fetchedAt: "2026-07-10T00:00:00Z",
    ...overrides
  };
}

function makeEntry(overrides: Partial<ListingEntry> = {}): ListingEntry {
  return {
    detailUrl: "https://www.sebi.gov.in/circulars/test.html",
    listingTitle: "SEBI Circular on Client Margin Reporting",
    listingDateText: "July 8, 2026",
    listingCategoryHint: "Stockbroker",
    ...overrides
  };
}

describe("detectChangeType", () => {
  it("returns 'unchanged' on an exact source_hash match (FR-12)", async () => {
    const existing = makeCircular();
    const page = makePage({ sourceHash: existing.source_hash });
    const entry = makeEntry();

    const result = await detectChangeType(page, entry, {
      findCircularBySourceHash: async (hash) => (hash === existing.source_hash ? existing : null),
      findCircularsByTitleFuzzy: async () => []
    });

    expect(result.changeType).toBe("unchanged");
    expect(result.existing).toEqual(existing);
  });

  it("returns 'amendment' with the matched circular on a fuzzy title match above 0.85 (FR-13)", async () => {
    const existing = makeCircular({ title: "SEBI Circular on Client Margin Reporting" });
    const page = makePage({ sourceHash: "brand-new-hash" });
    const entry = makeEntry({ listingTitle: "SEBI Circular on Client Margin Reporting" });

    const result = await detectChangeType(page, entry, {
      findCircularBySourceHash: async () => null,
      findCircularsByTitleFuzzy: async () => [existing]
    });

    expect(result.changeType).toBe("amendment");
    expect(result.existing?.circular_id).toBe(existing.circular_id);
  });

  it("returns 'new' when neither hash nor fuzzy title matches (FR-14)", async () => {
    const page = makePage({ sourceHash: "brand-new-hash" });
    const entry = makeEntry({ listingTitle: "A Completely Unrelated Circular About Mutual Funds" });

    const result = await detectChangeType(page, entry, {
      findCircularBySourceHash: async () => null,
      findCircularsByTitleFuzzy: async () => [makeCircular({ title: "SEBI Circular on Client Margin Reporting" })]
    });

    expect(result.changeType).toBe("new");
    expect(result.existing).toBeNull();
  });

  it("returns 'new' when the best fuzzy match is below the 0.85 threshold", async () => {
    const page = makePage({ sourceHash: "brand-new-hash" });
    // Related but meaningfully different title — should score below 0.85.
    const entry = makeEntry({ listingTitle: "SEBI Circular on Enhanced Due Diligence for Stockbrokers" });

    const result = await detectChangeType(page, entry, {
      findCircularBySourceHash: async () => null,
      findCircularsByTitleFuzzy: async () => [makeCircular({ title: "SEBI Circular on Client Margin Reporting" })]
    });

    expect(result.changeType).toBe("new");
  });
});
