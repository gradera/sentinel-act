// FR-30(a): canonical JSON must be stable-key-order, not
// JSON.stringify's insertion-order default.
import { describe, expect, it } from "vitest";
import { canonicalize, sha256Hex, computePayloadHash, computeEntryHash } from "../../src/canonicalize.js";

describe("canonicalize", () => {
  it("produces the same string regardless of key insertion order", () => {
    const a = { b: 1, a: 2, c: { z: 1, y: 2 } };
    const b = { a: 2, c: { y: 2, z: 1 }, b: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it("preserves array element order (order is significant data)", () => {
    const value = { items: [3, 1, 2] };
    expect(canonicalize(value)).toBe('{"items":[3,1,2]}');
  });

  it("sorts nested object keys inside arrays too", () => {
    const value = { items: [{ b: 1, a: 2 }] };
    expect(canonicalize(value)).toBe('{"items":[{"a":2,"b":1}]}');
  });
});

describe("sha256Hex", () => {
  it("matches the known SHA-256 vector for an empty string", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("matches the known SHA-256 vector for 'abc'", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("computePayloadHash / computeEntryHash", () => {
  it("is deterministic across repeated calls with an equivalent-but-differently-ordered payload", () => {
    const p1 = { obligation_id: "ob-1", tier: "C", decision: "approve" };
    const p2 = { decision: "approve", obligation_id: "ob-1", tier: "C" };
    expect(computePayloadHash(p1)).toBe(computePayloadHash(p2));
  });

  it("computes entry_hash from the documented formula", () => {
    const payloadHash = computePayloadHash({ a: 1 });
    const entryHash = computeEntryHash({
      sequence_number: 1,
      timestamp: "2026-07-13T00:00:00.000Z",
      event_type: "HUMAN_REVIEW_SUBMITTED",
      payload_hash: payloadHash,
      prev_entry_hash: "0".repeat(64)
    });
    const expected = sha256Hex(`1|2026-07-13T00:00:00.000Z|HUMAN_REVIEW_SUBMITTED|${payloadHash}|${"0".repeat(64)}`);
    expect(entryHash).toBe(expected);
  });
});
