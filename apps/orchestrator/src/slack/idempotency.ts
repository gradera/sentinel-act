// Spec 11 FR-23 — short-TTL dedup cache for inbound Slack interactions.
// Defense-in-depth only: the authoritative dedup is still
// resumeOrchestratorRun's/recordHumanReview's (obligationId, reviewerId)
// idempotency at the Orchestrator (Spec 09 FR-30's guarantee, reused).
// This layer exists to short-circuit Slack's own retry-on-slow-ack
// behavior and genuine accidental double-clicks before they even reach
// the Orchestrator.
//
// In-memory LRU-ish cache (single-process default, consistent with
// orchestrator.workflow.ts's own in-process eventIdToRunId map and
// InMemorySuspendedRunIndex — see §13 "single Slack workspace assumption"
// for the same single-instance framing applied elsewhere in this unit).
// A Redis-backed variant would swap this module's implementation without
// changing its call sites.

export const IDEMPOTENCY_TTL_MS = 2 * 60 * 1000; // 2 minutes, per FR-23

interface CacheEntry {
  expiresAt: number;
}

export class SlackIdempotencyCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly ttlMs: number = IDEMPOTENCY_TTL_MS) {}

  /** Returns true if `key` was already seen within the TTL window (i.e.
   *  this call is a duplicate and MUST be acked 200 with no further
   *  processing). As a side effect, records `key` as seen (so the FIRST
   *  call for a given key returns false but still marks it). Also
   *  opportunistically evicts expired entries so the map does not grow
   *  unbounded under sustained traffic. */
  checkAndRecord(key: string, nowMs: number = Date.now()): boolean {
    this.evictExpired(nowMs);
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > nowMs) {
      return true;
    }
    this.entries.set(key, { expiresAt: nowMs + this.ttlMs });
    return false;
  }

  private evictExpired(nowMs: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= nowMs) {
        this.entries.delete(key);
      }
    }
  }

  /** Test/diagnostic helper only. */
  size(): number {
    return this.entries.size;
  }
}

/** FR-23's composite key: action_id + block_id + obligationId + reviewerId
 *  + a coarse time bucket (covers the case where Slack's own trigger_id/
 *  view.id is not present, e.g. a raw block_actions payload before a
 *  modal exists). `bucketMs` defaults to the same TTL so two interactions
 *  landing in the same window collide on purpose. */
export function buildCompositeIdempotencyKey(input: {
  actionId: string;
  blockId: string;
  obligationId: string;
  reviewerId: string;
  nowMs?: number;
  bucketMs?: number;
}): string {
  const nowMs = input.nowMs ?? Date.now();
  const bucketMs = input.bucketMs ?? IDEMPOTENCY_TTL_MS;
  const bucket = Math.floor(nowMs / bucketMs);
  return `composite:${input.actionId}:${input.blockId}:${input.obligationId}:${input.reviewerId}:${bucket}`;
}

/** Preferred key when Slack supplies its own single-use identifiers
 *  (trigger_id for block_actions, view.id for view_submission) — these
 *  are already unique-per-interaction by construction. */
export function buildSlackNativeIdempotencyKey(kind: "trigger_id" | "view_id", value: string): string {
  return `native:${kind}:${value}`;
}
