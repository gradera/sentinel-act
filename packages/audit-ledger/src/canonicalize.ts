// FR-30(a): canonicalize a payload to a deterministic JSON string —
// stable key ordering (sorted lexicographically at every nesting level),
// NOT `JSON.stringify`'s insertion-order default — so `payload_hash` is
// reproducible regardless of how the payload object was constructed.
import { createHash } from "node:crypto";

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    // Array order is significant data (e.g. ordering of reviews), never
    // resorted — only each element's own object keys are sorted.
    return value.map(sortValue);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** Deterministic JSON serialization of `value`, sorted-keys form. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

/** Lowercase hex SHA-256 digest of `input`. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** sha256(canonicalize(payload)), hex — FR-30(a)'s payload_hash formula,
 *  factored out so both `append()` and `verifyChainIntegrity()` (which
 *  must recompute it identically, FR-33a) share exactly one
 *  implementation. */
export function computePayloadHash(payload: Record<string, unknown>): string {
  return sha256Hex(canonicalize(payload));
}

/** sha256(`${sequence_number}|${timestamp}|${event_type}|${payload_hash}|${prev_entry_hash}`),
 *  hex — FR-30(e)'s entry_hash formula, shared by `append()` and
 *  `verifyChainIntegrity()` (FR-33b) for the same reason. */
export function computeEntryHash(input: {
  sequence_number: number;
  timestamp: string;
  event_type: string;
  payload_hash: string;
  prev_entry_hash: string;
}): string {
  return sha256Hex(
    `${input.sequence_number}|${input.timestamp}|${input.event_type}|${input.payload_hash}|${input.prev_entry_hash}`
  );
}
