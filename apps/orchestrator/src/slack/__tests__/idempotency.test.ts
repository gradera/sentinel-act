import { describe, expect, it } from "vitest";
import { SlackIdempotencyCache, buildCompositeIdempotencyKey, buildSlackNativeIdempotencyKey, IDEMPOTENCY_TTL_MS } from "../idempotency.js";

describe("SlackIdempotencyCache (FR-23)", () => {
  it("returns false for the first call and true for a duplicate within the TTL", () => {
    const cache = new SlackIdempotencyCache();
    const key = "composite:approve:review_actions:OBL-1:reviewer-1:0";
    expect(cache.checkAndRecord(key, 1_000)).toBe(false);
    expect(cache.checkAndRecord(key, 1_500)).toBe(true);
  });

  it("does not treat a key as duplicate once the TTL has expired", () => {
    const cache = new SlackIdempotencyCache(1_000); // 1s TTL for the test
    const key = "trigger:abc";
    expect(cache.checkAndRecord(key, 0)).toBe(false);
    expect(cache.checkAndRecord(key, 2_000)).toBe(false); // TTL expired -> not a dup
  });

  it("evicts expired entries so the map does not grow unbounded", () => {
    const cache = new SlackIdempotencyCache(100);
    cache.checkAndRecord("a", 0);
    cache.checkAndRecord("b", 0);
    expect(cache.size()).toBe(2);
    cache.checkAndRecord("c", 1_000); // far past TTL for a/b
    expect(cache.size()).toBe(1); // only "c" survives the eviction sweep
  });

  it("treats distinct keys independently", () => {
    const cache = new SlackIdempotencyCache();
    expect(cache.checkAndRecord("key-a", 0)).toBe(false);
    expect(cache.checkAndRecord("key-b", 0)).toBe(false);
  });

  it("default TTL constant is 2 minutes per FR-23", () => {
    expect(IDEMPOTENCY_TTL_MS).toBe(2 * 60 * 1000);
  });
});

describe("buildCompositeIdempotencyKey", () => {
  it("produces the same key for identical inputs within the same time bucket", () => {
    const input = { actionId: "approve", blockId: "review_actions", obligationId: "OBL-1", reviewerId: "r1", nowMs: 1_000, bucketMs: 120_000 };
    expect(buildCompositeIdempotencyKey(input)).toBe(buildCompositeIdempotencyKey({ ...input, nowMs: 1_500 }));
  });

  it("produces different keys across different obligationId/reviewerId/actionId", () => {
    const base = { actionId: "approve", blockId: "review_actions", obligationId: "OBL-1", reviewerId: "r1", nowMs: 1_000 };
    const key1 = buildCompositeIdempotencyKey(base);
    const key2 = buildCompositeIdempotencyKey({ ...base, reviewerId: "r2" });
    const key3 = buildCompositeIdempotencyKey({ ...base, actionId: "decline" });
    expect(key1).not.toBe(key2);
    expect(key1).not.toBe(key3);
  });
});

describe("buildSlackNativeIdempotencyKey", () => {
  it("namespaces trigger_id and view_id separately", () => {
    expect(buildSlackNativeIdempotencyKey("trigger_id", "abc")).not.toBe(buildSlackNativeIdempotencyKey("view_id", "abc"));
  });
});
