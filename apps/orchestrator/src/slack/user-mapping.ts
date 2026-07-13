// Spec 11 §11 Task 7, §13 — SlackUserMapping lookup (seed-script-backed
// for this build, no self-service admin UI — Builder mode is explicitly
// out of scope per Spec 00 §5) and conversations.open channel-id caching.
import type { SlackUserMapping } from "./types.js";
import { openConversation } from "./slack-client.js";

export interface SlackUserMappingStore {
  findByReviewerId(reviewerId: string): SlackUserMapping | null;
  findBySlackUserId(slackUserId: string): SlackUserMapping | null;
  all(): SlackUserMapping[];
}

/** In-memory store, seeded once at process startup. §13's recommended
 *  default: a one-time seed script run against Slack's
 *  `users.lookupByEmail`, keyed by each reviewer's corporate email
 *  (ReviewerSession.email) — the seeding mechanism itself (an offline
 *  script hitting the Slack Web API) is out of this module's runtime
 *  path; this class is just the resulting lookup table's in-memory
 *  shape, constructed from whatever seed data is loaded at startup (a
 *  JSON file, env var, or config-table read — deployment detail left to
 *  the caller of `createInMemoryUserMappingStore`). */
export class InMemorySlackUserMappingStore implements SlackUserMappingStore {
  private readonly byReviewerId = new Map<string, SlackUserMapping>();
  private readonly bySlackUserId = new Map<string, SlackUserMapping>();

  constructor(seed: SlackUserMapping[] = []) {
    for (const mapping of seed) {
      this.byReviewerId.set(mapping.reviewerId, mapping);
      this.bySlackUserId.set(mapping.slackUserId, mapping);
    }
  }

  findByReviewerId(reviewerId: string): SlackUserMapping | null {
    return this.byReviewerId.get(reviewerId) ?? null;
  }

  findBySlackUserId(slackUserId: string): SlackUserMapping | null {
    return this.bySlackUserId.get(slackUserId) ?? null;
  }

  all(): SlackUserMapping[] {
    return Array.from(this.byReviewerId.values());
  }

  /** Test/seed-script helper — not used on the interaction hot path. */
  upsert(mapping: SlackUserMapping): void {
    this.byReviewerId.set(mapping.reviewerId, mapping);
    this.bySlackUserId.set(mapping.slackUserId, mapping);
  }
}

/** §8's "SlackUserMapping missing for a reviewer who needs a card" row:
 *  callers check for `null` and skip Slack delivery for that reviewer,
 *  logging a warning — this function itself does not decide that policy,
 *  it is a pure lookup. */
export function resolveSlackUserMapping(store: SlackUserMappingStore, reviewerId: string): SlackUserMapping | null {
  return store.findByReviewerId(reviewerId);
}

// ---------------------------------------------------------------------------
// conversations.open caching — a DM channel id is stable for a given
// (bot, user) pair, so this unit avoids re-resolving it on every card
// send/update.
// ---------------------------------------------------------------------------

export class DmChannelCache {
  private readonly channelBySlackUserId = new Map<string, string>();

  get(slackUserId: string): string | undefined {
    return this.channelBySlackUserId.get(slackUserId);
  }

  set(slackUserId: string, channelId: string): void {
    this.channelBySlackUserId.set(slackUserId, channelId);
  }
}

export interface ResolveDmChannelDeps {
  botToken: string;
  cache: DmChannelCache;
  fetchImpl?: typeof fetch;
}

/** Resolves (and caches) the DM channel id for a Slack user, via
 *  conversations.open — idempotent on Slack's side (re-opening an
 *  existing DM just returns the same channel id), but caching avoids the
 *  extra Web API round-trip on every send. Returns null (never throws) on
 *  a Slack-side failure — callers treat this identically to a missing
 *  SlackUserMapping (§8: best-effort, non-fatal to the underlying review
 *  flow). */
export async function resolveDmChannel(slackUserId: string, deps: ResolveDmChannelDeps): Promise<string | null> {
  const cached = deps.cache.get(slackUserId);
  if (cached) {
    return cached;
  }
  const result = await openConversation({ botToken: deps.botToken, slackUserId, fetchImpl: deps.fetchImpl });
  if (!result.ok || !result.channel?.id) {
    return null;
  }
  deps.cache.set(slackUserId, result.channel.id);
  return result.channel.id;
}
