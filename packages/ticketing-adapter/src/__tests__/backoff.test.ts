// FR-16: computeBackoffDelayMs table-driven across attempts 1-10,
// confirming the doubling schedule and the maxBackoffMs cap.
import { describe, expect, it } from "vitest";
import { computeBackoffDelayMs } from "../mapping.js";
import type { TicketingContext } from "../types.js";

const ctx: Pick<TicketingContext, "config"> = {
  config: {
    defaultAssigneeRef: "queue:unassigned",
    maxAttempts: 8,
    baseBackoffMs: 60_000, // 1 minute
    maxBackoffMs: 21_600_000, // 6 hours
    outboxBatchSize: 20
  }
};

describe("computeBackoffDelayMs (FR-16)", () => {
  it.each([
    [1, 60_000], // 1m
    [2, 120_000], // 2m
    [3, 240_000], // 4m
    [4, 480_000], // 8m
    [5, 960_000], // 16m
    [6, 1_920_000], // 32m
    [7, 3_840_000], // 64m
    [8, 7_680_000], // 128m
    [9, 15_360_000], // 256m — still under the 6h cap (21_600_000)
    [10, 21_600_000] // 512m would be 30_720_000, capped at 21_600_000 (6h)
  ])("attempts=%s -> %sms", (attempts, expected) => {
    expect(computeBackoffDelayMs(attempts, ctx)).toBe(expected);
  });

  it("never returns a value greater than maxBackoffMs no matter how large attempts grows", () => {
    expect(computeBackoffDelayMs(50, ctx)).toBe(21_600_000);
  });
});
