// Spec 02 §10 unit test: overlapping-poll guard (FR-2). Simulates a
// second runPollCycle invocation while a mocked first run's promise is
// unresolved; asserts the second call returns immediately with a
// concurrent_run_skipped alert and never invokes browserFetch.
import { describe, expect, it, vi } from "vitest";
import { runPollCycle } from "../regulatory-watch.agent.js";
import type { WatchOpsAlert } from "../regulatory-watch.types.js";

describe("runPollCycle concurrency guard", () => {
  it("skips (does not queue) a second run started while the first is still in-flight", async () => {
    const browserFetch = vi.fn(() => new Promise<never>(() => {})); // never resolves
    const alerts: WatchOpsAlert[] = [];
    const postOpsAlertWebhook = vi.fn(async (alert: WatchOpsAlert) => {
      alerts.push(alert);
    });

    const deps = {
      browserFetch,
      postOpsAlertWebhook,
      listingUrls: ["https://www.sebi.gov.in/circulars.html"],
      findCircularBySourceHash: async () => null,
      findCircularsByTitleFuzzy: async () => [],
      rowCountHistory: new Map<string, number>(),
      maxRetries: 0,
      sleep: async () => undefined
    };

    // Not awaited — starts executing synchronously up to its first real
    // await (inside browserFetch, which never resolves), then yields.
    // This first call legitimately calls browserFetch exactly once
    // (that's what makes it "in flight" for the guard to detect) — the
    // guarantee under test is that the SECOND call adds no additional
    // browserFetch call, not that browserFetch is never called at all.
    const firstRunPromise = runPollCycle(deps);

    const secondRun = await runPollCycle(deps);

    expect(secondRun.entriesSeen).toBe(0);
    expect(secondRun.triggersEmitted).toBe(0);
    // Exactly the first run's own call — the second (skipped) run must
    // not have added a second invocation.
    expect(browserFetch).toHaveBeenCalledTimes(1);
    expect(alerts.some((a) => a.kind === "concurrent_run_skipped" && a.severity === "warning")).toBe(true);

    // Keep the unresolved first-run promise referenced so it isn't
    // reported as an unhandled rejection if it ever settles; we don't
    // need it to resolve for this test.
    void firstRunPromise;
  });
});
