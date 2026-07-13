// Spec 08 gap-closure — orchestrator.sla-feed.ts unit tests. Exercises
// `handleSlaBreachFeedRequest` against the REAL `InMemorySuspendedRunIndex`
// (not a mock), the same test-double the rest of Spec 08's suite already
// treats as "the default in-memory SuspendedRunIndexPort" — so the
// dueSoon computation here is proven end-to-end against real claimed-slot
// state, not a hand-rolled fake.
import { describe, it, expect, beforeEach } from "vitest";
import { InMemorySuspendedRunIndex } from "../orchestrator.logic.js";
import {
  computeFeedSlaState,
  computeSlaDueAt,
  handleSlaBreachFeedRequest,
  REVIEW_SLA_HOURS_TIER_B,
  REVIEW_SLA_HOURS_TIER_C,
  SLA_DUE_SOON_WINDOW_HOURS
} from "../orchestrator.sla-feed.js";

const HOUR_MS = 60 * 60 * 1000;

describe("computeSlaDueAt", () => {
  it("Tier B: suspendedAt + 24h", () => {
    expect(computeSlaDueAt("2026-07-13T00:00:00.000Z", "B")).toBe(
      new Date(new Date("2026-07-13T00:00:00.000Z").getTime() + REVIEW_SLA_HOURS_TIER_B * HOUR_MS).toISOString()
    );
  });

  it("Tier C: suspendedAt + 12h", () => {
    expect(computeSlaDueAt("2026-07-13T00:00:00.000Z", "C")).toBe(
      new Date(new Date("2026-07-13T00:00:00.000Z").getTime() + REVIEW_SLA_HOURS_TIER_C * HOUR_MS).toISOString()
    );
  });
});

describe("computeFeedSlaState", () => {
  const dueAt = "2026-07-13T12:00:00.000Z";

  it("ok: well before dueAt", () => {
    expect(computeFeedSlaState(dueAt, new Date("2026-07-13T06:00:00.000Z"))).toBe("ok");
  });

  it("due_soon: within SLA_DUE_SOON_WINDOW_HOURS of dueAt", () => {
    const now = new Date(new Date(dueAt).getTime() - (SLA_DUE_SOON_WINDOW_HOURS - 1) * HOUR_MS);
    expect(computeFeedSlaState(dueAt, now)).toBe("due_soon");
  });

  it("breached: now >= dueAt", () => {
    expect(computeFeedSlaState(dueAt, new Date(dueAt))).toBe("breached");
    expect(computeFeedSlaState(dueAt, new Date(new Date(dueAt).getTime() + HOUR_MS))).toBe("breached");
  });
});

describe("handleSlaBreachFeedRequest — Tier C due-soon (real InMemorySuspendedRunIndex, real claimed slots)", () => {
  let index: InMemorySuspendedRunIndex;
  const NOW = new Date("2026-07-13T12:00:00.000Z");
  const nowFn = () => NOW;

  beforeEach(() => {
    index = new InMemorySuspendedRunIndex();
  });

  it("a claimed Tier C entry past the due-soon threshold appears exactly once in dueSoon, with the correct slaDueAt", async () => {
    // Tier C SLA is 12h; suspended 11.5h before NOW puts it 0.5h from
    // dueAt — inside the 4h due-soon window.
    const suspendedAt = new Date(NOW.getTime() - 11.5 * HOUR_MS).toISOString();
    await index.record({ obligation_id: "obl-1", runId: "run-1", stepId: "awaitHumanReview", tier: "C", suspendedAt });
    await index.claim("obl-1", "reviewer-maker");

    const result = await handleSlaBreachFeedRequest({ index }, nowFn);

    const expectedSlaDueAt = computeSlaDueAt(suspendedAt, "C");
    expect(result.dueSoon).toEqual([{ obligationId: "obl-1", reviewerId: "reviewer-maker", slaDueAt: expectedSlaDueAt }]);
  });

  it("a second call does NOT duplicate the same (obligation_id, reviewerId) due-soon row (idempotency via hasSentDueSoonReminder)", async () => {
    const suspendedAt = new Date(NOW.getTime() - 11.5 * HOUR_MS).toISOString();
    await index.record({ obligation_id: "obl-1", runId: "run-1", stepId: "awaitHumanReview", tier: "C", suspendedAt });
    await index.claim("obl-1", "reviewer-maker");

    const first = await handleSlaBreachFeedRequest({ index }, nowFn);
    expect(first.dueSoon).toHaveLength(1);

    const second = await handleSlaBreachFeedRequest({ index }, nowFn);
    expect(second.dueSoon).toHaveLength(0);
  });

  it("an entry still within the 'ok' window (not due-soon yet) does not appear", async () => {
    // Suspended only 1h ago -> dueAt is 11h out, well outside the 4h window.
    const suspendedAt = new Date(NOW.getTime() - 1 * HOUR_MS).toISOString();
    await index.record({ obligation_id: "obl-2", runId: "run-2", stepId: "awaitHumanReview", tier: "C", suspendedAt });
    await index.claim("obl-2", "reviewer-maker");

    const result = await handleSlaBreachFeedRequest({ index }, nowFn);
    expect(result.dueSoon).toHaveLength(0);
  });

  it("a Tier C entry with an unclaimed slot does not appear for that slot (no reviewerId to notify)", async () => {
    const suspendedAt = new Date(NOW.getTime() - 11.5 * HOUR_MS).toISOString();
    await index.record({ obligation_id: "obl-3", runId: "run-3", stepId: "awaitHumanReview", tier: "C", suspendedAt });
    // No .claim() call at all — both maker and checker slots are open.

    const result = await handleSlaBreachFeedRequest({ index }, nowFn);
    expect(result.dueSoon).toHaveLength(0);
  });

  it("a claimed maker AND claimed checker both surface independently as separate dueSoon rows", async () => {
    const suspendedAt = new Date(NOW.getTime() - 11.5 * HOUR_MS).toISOString();
    await index.record({ obligation_id: "obl-4", runId: "run-4", stepId: "awaitSecondHumanReview", tier: "C", suspendedAt });
    await index.claim("obl-4", "reviewer-maker");
    await index.claim("obl-4", "reviewer-checker");

    const result = await handleSlaBreachFeedRequest({ index }, nowFn);
    const reviewerIds = result.dueSoon.map((e) => e.reviewerId).sort();
    expect(reviewerIds).toEqual(["reviewer-checker", "reviewer-maker"]);
  });

  it("a Tier B entry never appears in dueSoon regardless of how overdue it is (documented gap: no assignedReviewerId concept for Tier B)", async () => {
    // Suspended 100h ago on a 24h Tier B SLA — wildly breached, not merely
    // due-soon. Still must never appear: there is no reviewer identity to
    // notify for Tier B anywhere in the shipped system.
    const suspendedAt = new Date(NOW.getTime() - 100 * HOUR_MS).toISOString();
    await index.record({ obligation_id: "obl-5", runId: "run-5", stepId: "awaitHumanReview", tier: "B", suspendedAt });

    const result = await handleSlaBreachFeedRequest({ index }, nowFn);
    expect(result.dueSoon).toHaveLength(0);
  });

  it("breached is always [] regardless of input — intentional (no backup-reviewer registry/policy exists anywhere in the shipped system), not a bug", async () => {
    // A wildly-overdue, fully-claimed Tier C entry — the one case that
    // WOULD populate `breached` if this implementation fabricated a
    // backup-reviewer policy. It must not.
    const suspendedAt = new Date(NOW.getTime() - 1000 * HOUR_MS).toISOString();
    await index.record({ obligation_id: "obl-6", runId: "run-6", stepId: "awaitHumanReview", tier: "C", suspendedAt });
    await index.claim("obl-6", "reviewer-maker");
    await index.claim("obl-6", "reviewer-checker");

    const result = await handleSlaBreachFeedRequest({ index }, nowFn);
    expect(result.breached).toEqual([]);
  });

  it("multiple obligations mix correctly: only the due-soon Tier C claimed slots are returned", async () => {
    const dueSoonAt = new Date(NOW.getTime() - 11.5 * HOUR_MS).toISOString();
    const okAt = new Date(NOW.getTime() - 1 * HOUR_MS).toISOString();

    await index.record({ obligation_id: "obl-due-soon", runId: "run-a", stepId: "awaitHumanReview", tier: "C", suspendedAt: dueSoonAt });
    await index.claim("obl-due-soon", "reviewer-x");

    await index.record({ obligation_id: "obl-ok", runId: "run-b", stepId: "awaitHumanReview", tier: "C", suspendedAt: okAt });
    await index.claim("obl-ok", "reviewer-y");

    await index.record({ obligation_id: "obl-tier-b", runId: "run-c", stepId: "awaitHumanReview", tier: "B", suspendedAt: dueSoonAt });

    const result = await handleSlaBreachFeedRequest({ index }, nowFn);
    expect(result.dueSoon).toEqual([{ obligationId: "obl-due-soon", reviewerId: "reviewer-x", slaDueAt: computeSlaDueAt(dueSoonAt, "C") }]);
    expect(result.breached).toEqual([]);
  });
});
