import { describe, it, expect } from "vitest";
import { computeUrgency } from "./urgency";

const NOW = new Date("2026-07-12T12:00:00.000Z");

function hoursFromNow(h: number): string {
  return new Date(NOW.getTime() + h * 60 * 60 * 1000).toISOString();
}

describe("computeUrgency (Spec 14 FR-4, FR-5, §8 edge cases)", () => {
  it("returns archive when decided, regardless of SLA proximity", () => {
    expect(
      computeUrgency({ slaDueAt: hoursFromNow(1), decidedAt: "2026-07-10T00:00:00.000Z", now: NOW })
    ).toBe("archive");
  });

  it("returns archive when decided even if slaDueAt is null", () => {
    expect(computeUrgency({ slaDueAt: null, decidedAt: "2026-07-10T00:00:00.000Z", now: NOW })).toBe("archive");
  });

  it("returns archive when decided even if the SLA was already breached", () => {
    expect(
      computeUrgency({ slaDueAt: hoursFromNow(-10), decidedAt: "2026-07-10T00:00:00.000Z", now: NOW })
    ).toBe("archive");
  });

  it("returns now when undecided and already past-due", () => {
    expect(computeUrgency({ slaDueAt: hoursFromNow(-1), decidedAt: null, now: NOW })).toBe("now");
  });

  it("returns now when undecided and within the default 4h threshold", () => {
    expect(computeUrgency({ slaDueAt: hoursFromNow(3), decidedAt: null, now: NOW })).toBe("now");
  });

  it("returns now exactly at the threshold boundary (inclusive)", () => {
    expect(computeUrgency({ slaDueAt: hoursFromNow(4), decidedAt: null, now: NOW })).toBe("now");
  });

  it("returns in-motion when undecided and beyond the default 4h threshold", () => {
    expect(computeUrgency({ slaDueAt: hoursFromNow(4.5), decidedAt: null, now: NOW })).toBe("in-motion");
  });

  it("returns in-motion when undecided and far in the future", () => {
    expect(computeUrgency({ slaDueAt: hoursFromNow(72), decidedAt: null, now: NOW })).toBe("in-motion");
  });

  it("returns in-motion as the safe default when both slaDueAt and decidedAt are null", () => {
    expect(computeUrgency({ slaDueAt: null, decidedAt: null, now: NOW })).toBe("in-motion");
  });

  it("respects a custom nowThresholdHours override", () => {
    expect(computeUrgency({ slaDueAt: hoursFromNow(6), decidedAt: null, nowThresholdHours: 8, now: NOW })).toBe("now");
    expect(computeUrgency({ slaDueAt: hoursFromNow(6), decidedAt: null, nowThresholdHours: 2, now: NOW })).toBe(
      "in-motion"
    );
  });

  it("defaults `now` to the current wall clock when not injected", () => {
    // Sanity check the injectable-now default path still returns a valid level.
    const level = computeUrgency({ slaDueAt: null, decidedAt: null });
    expect(["now", "in-motion", "archive"]).toContain(level);
  });
});
