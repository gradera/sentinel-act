// Spec 12 §7 NFR-5: "the assistant MUST rate-limit questions per reviewer
// session ... default 20 requests/minute, configurable via
// ASSISTANT_RATE_LIMIT_PER_MINUTE ... exceeding it returns 429."
//
// No precedent for this in the codebase to mirror (audit/export has a
// concurrency CAP — NFR-7, at most N jobs running at once — which is a
// different thing from a per-identity request-rate window), so this is a
// new, small, deliberately simple design:
//
// - In-memory only, per Node process — same "honest limitation" class as
//   export/route.ts's fire-and-forget background job: this resets on
//   deploy/restart and does NOT coordinate across multiple server
//   instances behind a load balancer. Fine for a single-instance
//   deployment (matches this app's current reality — no shared
//   Redis/cache layer exists anywhere in this repo yet); a real
//   multi-instance production deployment would need a shared store
//   (Redis INCR+EXPIRE, or equivalent) instead. Flagged, not silently
//   pretended away, mirroring export/route.ts's own precedent for this
//   kind of gap.
// - Fixed 60-second window, keyed by `session.reviewerId` (never a
//   client-supplied identifier — NFR-Security-2's invariant, same as
//   every other identity-keyed thing in this app) — a sliding counter
//   that resets once the window elapses, not a true sliding-log/token
//   bucket. Simple and sufficient for "prevent one reviewer from hammering
//   the LLM/graph": exact boundary smoothing (e.g. a burst spanning two
//   windows) is not a design goal here.
import { jsonError } from "./route-errors";
import type { NextResponse } from "next/server";

const DEFAULT_RATE_LIMIT_PER_MINUTE = 20;
const WINDOW_MS = 60_000;

interface RateLimitBucket {
  windowStart: number;
  count: number;
}

// Module-level state — one bucket map per Node process (see top-of-file
// comment on why this doesn't coordinate across instances).
const buckets = new Map<string, RateLimitBucket>();

function readRateLimitPerMinute(): number {
  const raw = process.env.ASSISTANT_RATE_LIMIT_PER_MINUTE;
  if (!raw) {
    return DEFAULT_RATE_LIMIT_PER_MINUTE;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RATE_LIMIT_PER_MINUTE;
}

/** Returns `true` (and records the hit) if `reviewerId` is still within
 *  its per-minute budget; `false` if this call would exceed it (the
 *  caller should NOT count a rejected call towards the next window —
 *  this function only increments on an allowed call). */
export function allowAssistantRequest(reviewerId: string, now: number = Date.now()): boolean {
  const limit = readRateLimitPerMinute();
  const bucket = buckets.get(reviewerId);

  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    buckets.set(reviewerId, { windowStart: now, count: 1 });
    return true;
  }

  if (bucket.count >= limit) {
    return false;
  }

  bucket.count += 1;
  return true;
}

/** Test-only escape hatch — vitest doesn't reload this module between
 *  test files run in the same worker, and module-level Map state would
 *  otherwise leak across unrelated tests. */
export function resetAssistantRateLimitsForTest(): void {
  buckets.clear();
}

export function rateLimitExceededResponse(): NextResponse {
  return jsonError(429, "TOO_MANY_REQUESTS", "too many requests, please slow down.");
}
