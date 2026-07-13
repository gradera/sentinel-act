// Spec 09 §12: "computeSlaState boundary at the exact 4h threshold
// (ok/due_soon/breached)" and "the queue sort comparator (risk desc, SLA
// asc, null last, stable)".
import { describe, expect, it } from "vitest";
import {
  compareQueueItems,
  computeSlaState,
  reviewSlaHours,
  REVIEW_SLA_HOURS_TIER_B,
  REVIEW_SLA_HOURS_TIER_C,
  SLA_DUE_SOON_WINDOW_HOURS,
  type QueueSortable
} from "./sla";

// FR-3 (PARTIAL — see apps/web-console/lib/console/FR-TRACEABILITY.md for the
// rest): FR-3's full requirement is that the Orchestrator computes
// `slaDueAt = suspendedAt + reviewSlaHours(tier)` at suspend time. That
// suspend-timing computation lives in apps/orchestrator and is not on the
// wire yet (queue/route.ts and items/[obligationId]/route.ts both document
// this as an open gap — slaDueAt is hardcoded null today). The one part of
// FR-3 actually implemented in THIS app is the pair of named, exported
// placeholder constants FR-3's own text specifies ("Tier B = 24 hours,
// Tier C = 12 hours per reviewer slot") — this test asserts those values,
// honestly scoped to only that much of the requirement.
describe("reviewSlaHours (FR-3 placeholder constants)", () => {
  it("Tier B review SLA is 24 hours", () => {
    expect(REVIEW_SLA_HOURS_TIER_B).toBe(24);
    expect(reviewSlaHours.B).toBe(24);
  });

  it("Tier C review SLA is 12 hours", () => {
    expect(REVIEW_SLA_HOURS_TIER_C).toBe(12);
    expect(reviewSlaHours.C).toBe(12);
  });
});

// FR-4: slaState bucketing — "breached" when now >= slaDueAt, "due_soon"
// when slaDueAt - now <= SLA_DUE_SOON_WINDOW_HOURS (4h), else "ok".
describe("computeSlaState", () => {
  const FOUR_HOURS_MS = SLA_DUE_SOON_WINDOW_HOURS * 60 * 60 * 1000;
  const now = new Date("2026-07-13T12:00:00.000Z");

  it("returns 'ok' when slaDueAt is null (no SLA clock running, never an alarm)", () => {
    expect(computeSlaState(null, now)).toBe("ok");
  });

  it("returns 'breached' when now === slaDueAt exactly", () => {
    expect(computeSlaState(now.toISOString(), now)).toBe("breached");
  });

  it("returns 'breached' when now is after slaDueAt", () => {
    const past = new Date(now.getTime() - 1000).toISOString();
    expect(computeSlaState(past, now)).toBe("breached");
  });

  it("returns 'due_soon' at exactly the 4-hour boundary (dueAt - now === 4h)", () => {
    const dueAt = new Date(now.getTime() + FOUR_HOURS_MS).toISOString();
    expect(computeSlaState(dueAt, now)).toBe("due_soon");
  });

  it("returns 'due_soon' 1ms inside the 4-hour boundary", () => {
    const dueAt = new Date(now.getTime() + FOUR_HOURS_MS - 1).toISOString();
    expect(computeSlaState(dueAt, now)).toBe("due_soon");
  });

  it("returns 'ok' 1ms past the 4-hour boundary (dueAt - now === 4h + 1ms)", () => {
    const dueAt = new Date(now.getTime() + FOUR_HOURS_MS + 1).toISOString();
    expect(computeSlaState(dueAt, now)).toBe("ok");
  });

  it("returns 'ok' well beyond the 4-hour window", () => {
    const dueAt = new Date(now.getTime() + FOUR_HOURS_MS * 10).toISOString();
    expect(computeSlaState(dueAt, now)).toBe("ok");
  });
});

// FR-5: queue sort comparator — riskScore DESC, then slaDueAt ASC NULLS
// LAST, stable (secondary in-memory sort applied after Orchestrator SLA
// data is merged in; see queue/route.ts's own FR-5 usage of this
// comparator, tested at the route level in queue/route.test.ts too).
describe("compareQueueItems", () => {
  it("sorts by riskScore DESC when risk scores differ", () => {
    const a: QueueSortable = { riskScore: 0.3, slaDueAt: null };
    const b: QueueSortable = { riskScore: 0.9, slaDueAt: null };
    expect(compareQueueItems(a, b)).toBeGreaterThan(0); // a should sort after b
    expect(compareQueueItems(b, a)).toBeLessThan(0); // b should sort before a
  });

  it("sorts by slaDueAt ASC when riskScore ties", () => {
    const earlier: QueueSortable = { riskScore: 0.5, slaDueAt: "2026-07-13T08:00:00.000Z" };
    const later: QueueSortable = { riskScore: 0.5, slaDueAt: "2026-07-13T10:00:00.000Z" };
    expect(compareQueueItems(earlier, later)).toBeLessThan(0);
    expect(compareQueueItems(later, earlier)).toBeGreaterThan(0);
  });

  it("puts null slaDueAt LAST among tied riskScores", () => {
    const withSla: QueueSortable = { riskScore: 0.5, slaDueAt: "2026-07-13T08:00:00.000Z" };
    const withoutSla: QueueSortable = { riskScore: 0.5, slaDueAt: null };
    expect(compareQueueItems(withoutSla, withSla)).toBeGreaterThan(0); // null sorts after
    expect(compareQueueItems(withSla, withoutSla)).toBeLessThan(0);
  });

  it("both-null slaDueAt with tied riskScore compares equal (0)", () => {
    const a: QueueSortable = { riskScore: 0.5, slaDueAt: null };
    const b: QueueSortable = { riskScore: 0.5, slaDueAt: null };
    expect(compareQueueItems(a, b)).toBe(0);
  });

  it("end-to-end: sorts a mixed array risk DESC, then sla ASC nulls-last", () => {
    const items: Array<QueueSortable & { id: string }> = [
      { id: "low-risk", riskScore: 0.2, slaDueAt: "2026-07-13T06:00:00.000Z" },
      { id: "high-risk-no-sla", riskScore: 0.9, slaDueAt: null },
      { id: "high-risk-later-sla", riskScore: 0.9, slaDueAt: "2026-07-13T10:00:00.000Z" },
      { id: "high-risk-earlier-sla", riskScore: 0.9, slaDueAt: "2026-07-13T08:00:00.000Z" }
    ];
    const sorted = [...items].sort(compareQueueItems).map((i) => i.id);
    expect(sorted).toEqual(["high-risk-earlier-sla", "high-risk-later-sla", "high-risk-no-sla", "low-risk"]);
  });

  it("is stable: items tied on both riskScore and slaDueAt (including both-null) preserve original relative order", () => {
    const items: Array<QueueSortable & { id: string }> = [
      { id: "first", riskScore: 0.5, slaDueAt: null },
      { id: "second", riskScore: 0.5, slaDueAt: null },
      { id: "third", riskScore: 0.5, slaDueAt: null }
    ];
    const sorted = [...items].sort(compareQueueItems).map((i) => i.id);
    expect(sorted).toEqual(["first", "second", "third"]);
  });

  it("is stable: items tied on both riskScore and an identical non-null slaDueAt preserve original relative order", () => {
    const items: Array<QueueSortable & { id: string }> = [
      { id: "alpha", riskScore: 0.7, slaDueAt: "2026-07-13T09:00:00.000Z" },
      { id: "beta", riskScore: 0.7, slaDueAt: "2026-07-13T09:00:00.000Z" }
    ];
    const sorted = [...items].sort(compareQueueItems).map((i) => i.id);
    expect(sorted).toEqual(["alpha", "beta"]);
  });
});
