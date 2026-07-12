// Watch-agent read surface (Spec 02 §3/§4). `findCircularBySourceHash`
// and `findCircularsByTitleFuzzy` are the ONLY two graph-read functions
// the Regulatory Watch and Ingestion Agent (Spec 02,
// apps/orchestrator/src/mastra/agents/regulatory-watch.agent.ts) is
// allowed to call directly — Spec 01 §1's boundary ("never write raw
// Cypher against this graph outside this package") means both live
// here, not in apps/orchestrator, and Watch only ever imports the
// exported function below, never a Driver/session/Cypher string of its
// own.
//
// Standalone functions (not a repository class) because Spec 02 §4
// documents their call signature as free functions
// (`findCircularBySourceHash(hash: string): Promise<Circular | null>`),
// not methods on an instantiated repository. Each takes an optional
// `driver` param (defaulting to the process-wide `getDriver()`
// singleton) so callers keep the spec's exact primary signature while
// tests can still inject a mock Driver — the same seam `driver.ts`'s own
// `verifyConnectivity(driver?: Driver)` already uses.
//
// Design decision on the fuzzy-scoring boundary (documented here because
// spec §3/§4 flags it as genuinely ambiguous, not settled): this module
// does a coarse Cypher pre-filter —
//   MATCH (c:Circular {category: $category}) WHERE c.valid_to IS NULL
//   RETURN c
// — and then scores every result against `title` in application code
// (never inside Cypher). `findCircularsByTitleFuzzy` returns the
// category's live circulars sorted by descending similarity to `title`,
// pruned only against a low internal floor (`TITLE_SIMILARITY_FLOOR`,
// 0.3) that exists purely to keep the returned candidate list small when
// a category member is obviously unrelated. The two decision thresholds
// the spec actually calls out (0.85 for FR-13's full-document match;
// the +0.3 confidence bump at 0.7 for FR-18's amendment-target
// resolution) are deliberately NOT applied here — they're applied by the
// caller (regulatory-watch.agent.ts), because this function has no way
// to know which of the two different extracted title strings (the
// listing title vs. a regex-extracted "referenced circular" phrase) a
// given call is scoring against, and the two call sites want different
// thresholds against the same ranked list.
import type { Driver } from "neo4j-driver";
import type { Circular } from "@sentinel-act/graph-schema";
import { getDriver, getSingletonDatabase } from "../driver.js";
import { logOperation } from "../logger.js";
import { serializeProperties } from "./serialize.js";

// Mirrors CircularRepository's own `nullableFields` getter
// (BaseRepository's ["valid_to"] plus "supersedes_circular_id").
// Duplicated (rather than instantiating a CircularRepository just to
// read a protected getter) because both call sites must independently
// satisfy serialize.ts's "every legitimately-nullable field must be
// listed" contract — see circular.repository.ts.
const CIRCULAR_NULLABLE_FIELDS = ["valid_to", "supersedes_circular_id"] as const;

function deserializeCircular(properties: Record<string, unknown>): Circular {
  return serializeProperties<Circular>(properties, CIRCULAR_NULLABLE_FIELDS);
}

/**
 * Spec 02 §4's documented Cypher shape, verbatim:
 *   MATCH (c:Circular {source_hash: $sourceHash}) RETURN c LIMIT 1
 * This is FR-12's primary idempotency check — an exact `source_hash`
 * match means "already ingested, do nothing further" (changeType =
 * "unchanged").
 */
export async function findCircularBySourceHash(hash: string, driver?: Driver): Promise<Circular | null> {
  const start = Date.now();
  const activeDriver = driver ?? getDriver();
  const session = activeDriver.session({ database: getSingletonDatabase() });
  try {
    const result = await session.executeRead((tx) =>
      tx.run(`MATCH (c:Circular {source_hash: $hash}) RETURN c LIMIT 1`, { hash })
    );
    const record = result.records[0];
    const value = record ? deserializeCircular(record.get("c").properties as Record<string, unknown>) : null;
    logOperation({
      operation: "findCircularBySourceHash",
      label: "Circular",
      durationMs: Date.now() - start,
      outcome: "success"
    });
    return value;
  } catch (error) {
    logOperation({
      operation: "findCircularBySourceHash",
      label: "Circular",
      durationMs: Date.now() - start,
      outcome: "error"
    });
    throw error;
  } finally {
    await session.close();
  }
}

const TITLE_SIMILARITY_FLOOR = 0.3;

/**
 * Spec 02 §4's documented Cypher pre-filter, verbatim:
 *   MATCH (c:Circular {category: $category})
 *   WHERE c.valid_to IS NULL
 *   RETURN c
 * followed by application-level fuzzy scoring against `title` (see the
 * module doc comment above for why the two spec thresholds are NOT
 * applied inside this function). Used by Watch for both FR-13
 * (full-document supersession match) and FR-17 (paragraph-level
 * amendment target resolution).
 */
export async function findCircularsByTitleFuzzy(
  title: string,
  category: string,
  driver?: Driver
): Promise<Circular[]> {
  const start = Date.now();
  const activeDriver = driver ?? getDriver();
  const session = activeDriver.session({ database: getSingletonDatabase() });
  try {
    const result = await session.executeRead((tx) =>
      tx.run(`MATCH (c:Circular {category: $category}) WHERE c.valid_to IS NULL RETURN c`, { category })
    );
    const scored = result.records
      .map((record) => deserializeCircular(record.get("c").properties as Record<string, unknown>))
      .map((circular) => ({ circular, score: titleSimilarity(title, circular.title) }))
      .filter((entry) => entry.score >= TITLE_SIMILARITY_FLOOR)
      .sort((a, b) => b.score - a.score);
    logOperation({
      operation: "findCircularsByTitleFuzzy",
      label: "Circular",
      durationMs: Date.now() - start,
      outcome: "success",
      detail: { category, resultCount: scored.length }
    });
    return scored.map((entry) => entry.circular);
  } catch (error) {
    logOperation({
      operation: "findCircularsByTitleFuzzy",
      label: "Circular",
      durationMs: Date.now() - start,
      outcome: "error"
    });
    throw error;
  } finally {
    await session.close();
  }
}

// ---- Normalized string similarity (token-sort Levenshtein ratio) -------
// Hand-rolled rather than a new dependency (§13: "implement with a
// standard normalized string similarity ... no real corpus ... yet" —
// this is a small, self-contained algorithm, not worth a package).

function normalizeForComparison(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sorting words alphabetically before diffing means two renderings of
 *  the same title that differ only in word order (rare, but SEBI listing
 *  vs. detail-page titles do sometimes reorder a trailing date clause)
 *  don't get penalized as heavily as a raw Levenshtein diff would. */
function tokenSort(value: string): string {
  return normalizeForComparison(value).split(" ").filter(Boolean).sort().join(" ");
}

function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) dp[i][0] = i;
  for (let j = 0; j < cols; j++) dp[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[rows - 1][cols - 1];
}

/** Normalized token-sort Levenshtein similarity, 0..1 (1 = identical
 *  after case/punctuation normalization and alphabetical word-sort).
 *  Exported so Spec 02's own confidence heuristic (FR-18: "+0.3 if a
 *  target title match clears 0.7 similarity") can reuse the exact same
 *  scoring function this module uses internally, rather than a second
 *  hand-rolled implementation silently drifting out of sync with this
 *  one. */
export function titleSimilarity(a: string, b: string): number {
  const ta = tokenSort(a);
  const tb = tokenSort(b);
  const maxLen = Math.max(ta.length, tb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(ta, tb) / maxLen;
}
