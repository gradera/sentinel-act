// Spec 02 §10 integration tests: mocked Browser primitive returning
// fixture HTML, in-memory mock graph-read stubs for
// findCircularBySourceHash / findCircularsByTitleFuzzy, running the full
// runPollCycle orchestration end to end.
import { describe, expect, it, vi } from "vitest";
import { runPollCycle, canonicalizeText, computeSourceHash, type BrowserFetchConfig } from "../regulatory-watch.agent.js";
import type { RegulatoryWatchTriggerEvent, WatchOpsAlert } from "../regulatory-watch.types.js";
import type { Circular } from "@sentinel-act/graph-schema";
import { loadFixture } from "./fixtures.js";

const LISTING_URL = "https://www.sebi.gov.in/circulars.html";
const DUE_DILIGENCE_URL = "https://www.sebi.gov.in/circulars/2026/enhanced-due-diligence.html";
const MARGIN_REPORTING_URL = "https://www.sebi.gov.in/circulars/2026/client-margin-reporting.html";

const dueDiligenceHtml = loadFixture("detail-page-new-circular.html");
const marginReportingHtml = loadFixture("detail-page-client-margin-reporting.html");
const dueDiligenceHash = computeSourceHash(canonicalizeText(dueDiligenceHtml));
const marginReportingHash = computeSourceHash(canonicalizeText(marginReportingHtml));

function makeCircular(overrides: Partial<Circular> = {}): Circular {
  return {
    circular_id: "circ-existing-1",
    title: "SEBI Circular on Client Margin Reporting",
    type: "circular",
    category: "Stockbroker",
    date_issued: "2026-07-08",
    date_effective: "2026-07-08",
    source_hash: "existing-hash",
    supersedes_circular_id: null,
    valid_from: "2026-07-08",
    valid_to: null,
    recorded_at: "2026-07-08T00:00:00Z",
    ...overrides
  };
}

function makeBrowserFetch(pages: Record<string, string>) {
  return vi.fn(async (config: BrowserFetchConfig) => {
    const html = pages[config.url];
    if (html === undefined) throw new Error(`No fixture mapped for URL ${config.url}`);
    return { html, finalUrl: config.url };
  });
}

describe("runPollCycle — integration", () => {
  it("2-page listing: 1 genuinely new circular triggers, 1 already-seen-by-hash does not (Acceptance Criterion 1)", async () => {
    const events: RegulatoryWatchTriggerEvent[] = [];
    const browserFetch = makeBrowserFetch({
      [LISTING_URL]: loadFixture("listing-page-two-entries.html"),
      [DUE_DILIGENCE_URL]: dueDiligenceHtml,
      [MARGIN_REPORTING_URL]: marginReportingHtml
    });
    const existingCircular = makeCircular({ source_hash: marginReportingHash });

    const pollRun = await runPollCycle({
      browserFetch,
      listingUrls: [LISTING_URL],
      findCircularBySourceHash: async (hash) => (hash === marginReportingHash ? existingCircular : null),
      findCircularsByTitleFuzzy: async () => [],
      invokeOrchestrator: async (event) => {
        events.push(event);
      },
      postOpsAlertWebhook: async () => undefined,
      rowCountHistory: new Map(),
      sleep: async () => undefined,
      maxRetries: 0
    });

    expect(pollRun.entriesSeen).toBe(2);
    expect(pollRun.triggersEmitted).toBe(1);
    expect(pollRun.errors).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0].changeType).toBe("new");
    expect(events[0].circular.title).toBe("SEBI Circular on Enhanced Due Diligence for Stockbrokers");
    expect(events[0].circular.supersedes_circular_id).toBeNull();
    expect(events[0].circular.recorded_at).toBeNull();
    expect(events[0].clauses.length).toBeGreaterThan(0);
    expect(events[0].clauses.some((c) => c.para_ref === "1")).toBe(true);
    expect(events[0].clauses.every((c) => c.circular_id === events[0].circular.circular_id)).toBe(true);
  });

  it("re-running the same poll cycle after the new circular is persisted produces zero additional triggers (Acceptance Criterion 2)", async () => {
    const browserFetch = makeBrowserFetch({
      [LISTING_URL]: loadFixture("listing-page-two-entries.html"),
      [DUE_DILIGENCE_URL]: dueDiligenceHtml,
      [MARGIN_REPORTING_URL]: marginReportingHtml
    });
    const persisted = new Map<string, Circular>([
      [marginReportingHash, makeCircular({ source_hash: marginReportingHash })],
      [
        dueDiligenceHash,
        makeCircular({
          circular_id: "circ-due-diligence",
          title: "SEBI Circular on Enhanced Due Diligence for Stockbrokers",
          source_hash: dueDiligenceHash
        })
      ]
    ]);

    const pollRun = await runPollCycle({
      browserFetch,
      listingUrls: [LISTING_URL],
      findCircularBySourceHash: async (hash) => persisted.get(hash) ?? null,
      findCircularsByTitleFuzzy: async () => [],
      invokeOrchestrator: async () => {
        throw new Error("emitTrigger must not be called once every circular is already persisted");
      },
      postOpsAlertWebhook: async () => undefined,
      rowCountHistory: new Map(),
      sleep: async () => undefined,
      maxRetries: 0
    });

    expect(pollRun.triggersEmitted).toBe(0);
    expect(pollRun.errors).toHaveLength(0);
  });

  it("resolves the CUSPA/Paragraph 46 amendmentContext against a pre-seeded master circular (Acceptance Criterion 3)", async () => {
    const CUSPA_LISTING_URL = "https://www.sebi.gov.in/circulars-cuspa.html";
    const CUSPA_DETAIL_URL = "https://www.sebi.gov.in/circulars/2026/cuspa-amendment-paragraph-46.html";
    const masterCircular = makeCircular({
      circular_id: "circ-master-stockbrokers",
      title: "Master Circular for Stock Brokers",
      category: "Stockbroker",
      source_hash: "seeded-master-hash"
    });

    const browserFetch = makeBrowserFetch({
      [CUSPA_LISTING_URL]: loadFixture("listing-page-cuspa-amendment.html"),
      [CUSPA_DETAIL_URL]: loadFixture("detail-page-cuspa-amendment-paragraph-46.html")
    });
    const events: RegulatoryWatchTriggerEvent[] = [];

    const pollRun = await runPollCycle({
      browserFetch,
      listingUrls: [CUSPA_LISTING_URL],
      findCircularBySourceHash: async () => null,
      findCircularsByTitleFuzzy: async (_title, category) => (category === "Stockbroker" ? [masterCircular] : []),
      invokeOrchestrator: async (event) => {
        events.push(event);
      },
      postOpsAlertWebhook: async () => undefined,
      rowCountHistory: new Map(),
      sleep: async () => undefined,
      maxRetries: 0
    });

    expect(pollRun.triggersEmitted).toBe(1);
    expect(events).toHaveLength(1);
    const event = events[0];
    // FR-18: paragraph-level amendment is "new", not "amendment" via
    // the circular-level supersede path.
    expect(event.changeType).toBe("new");
    expect(event.circular.supersedes_circular_id).toBeNull();
    expect(event.amendmentContext).not.toBeNull();
    expect(event.amendmentContext?.targetCircularId).toBe("circ-master-stockbrokers");
    expect(event.amendmentContext?.targetMatchedOnTitle).toBe("Master Circular for Stock Brokers");
    expect(event.amendmentContext?.amendedParaRefs).toEqual(["46"]);
    expect(event.amendmentContext?.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it("selector-mismatch fixture: 0 rows where the previous poll saw >= 1 raises a critical alert, no candidates produced (Acceptance Criterion 4)", async () => {
    const alerts: WatchOpsAlert[] = [];
    const rowCountHistory = new Map<string, number>([[LISTING_URL, 12]]);
    const browserFetch = makeBrowserFetch({ [LISTING_URL]: loadFixture("listing-page-selector-mismatch.html") });

    const pollRun = await runPollCycle({
      browserFetch,
      listingUrls: [LISTING_URL],
      findCircularBySourceHash: async () => null,
      findCircularsByTitleFuzzy: async () => [],
      invokeOrchestrator: async () => {
        throw new Error("must not be called — no candidates should be produced");
      },
      postOpsAlertWebhook: async (alert) => {
        alerts.push(alert);
      },
      rowCountHistory,
      sleep: async () => undefined,
      maxRetries: 0
    });

    expect(pollRun.entriesSeen).toBe(0);
    expect(pollRun.triggersEmitted).toBe(0);
    expect(alerts.some((a) => a.kind === "selector_mismatch" && a.severity === "critical")).toBe(true);
    expect(pollRun.errors.some((e) => e.stage === "listing_fetch")).toBe(true);
  });

  it("upstream unavailable: all listing fetches fail after retries -> upstream_unavailable alert, zero candidates (Acceptance Criterion 5)", async () => {
    const alerts: WatchOpsAlert[] = [];
    const browserFetch = vi.fn(async () => {
      throw new Error("HTTP 503");
    });

    const pollRun = await runPollCycle({
      browserFetch,
      listingUrls: [LISTING_URL],
      findCircularBySourceHash: async () => null,
      findCircularsByTitleFuzzy: async () => [],
      invokeOrchestrator: async () => {
        throw new Error("must not be called");
      },
      postOpsAlertWebhook: async (alert) => {
        alerts.push(alert);
      },
      rowCountHistory: new Map(),
      sleep: async () => undefined,
      maxRetries: 2 // exercise the real retry count for this one test
    });

    // maxRetries=2 => up to 3 attempts per listing URL.
    expect(browserFetch).toHaveBeenCalledTimes(3);
    expect(pollRun.triggersEmitted).toBe(0);
    expect(pollRun.errors).toEqual([expect.objectContaining({ stage: "listing_fetch", detailUrl: LISTING_URL })]);
    expect(alerts.some((a) => a.kind === "upstream_unavailable" && a.severity === "critical")).toBe(true);
  });

  it("partial failure: one listing URL failing does not block the other from producing a trigger", async () => {
    const GOOD_URL = LISTING_URL;
    const BAD_URL = "https://www.sebi.gov.in/circulars-broken.html";
    const events: RegulatoryWatchTriggerEvent[] = [];

    const browserFetch = vi.fn(async (config: BrowserFetchConfig) => {
      if (config.url === BAD_URL) throw new Error("simulated network failure");
      if (config.url === GOOD_URL) return { html: loadFixture("listing-page-two-entries.html"), finalUrl: config.url };
      if (config.url === DUE_DILIGENCE_URL) return { html: dueDiligenceHtml, finalUrl: config.url };
      if (config.url === MARGIN_REPORTING_URL) return { html: marginReportingHtml, finalUrl: config.url };
      throw new Error(`unexpected URL ${config.url}`);
    });

    const pollRun = await runPollCycle({
      browserFetch,
      listingUrls: [BAD_URL, GOOD_URL],
      findCircularBySourceHash: async (hash) => (hash === marginReportingHash ? makeCircular({ source_hash: marginReportingHash }) : null),
      findCircularsByTitleFuzzy: async () => [],
      invokeOrchestrator: async (event) => {
        events.push(event);
      },
      postOpsAlertWebhook: async () => undefined,
      rowCountHistory: new Map(),
      sleep: async () => undefined,
      maxRetries: 0
    });

    expect(events).toHaveLength(1);
    expect(pollRun.triggersEmitted).toBe(1);
    expect(pollRun.errors.some((e) => e.stage === "listing_fetch" && e.detailUrl === BAD_URL)).toBe(true);
    expect(pollRun.listingUrlsPolled).toEqual([BAD_URL, GOOD_URL]);
  });

  it("records emitTrigger failures as PollError{stage: trigger_emit} without aborting the cycle (FR-26)", async () => {
    const browserFetch = makeBrowserFetch({
      [LISTING_URL]: loadFixture("listing-page-two-entries.html"),
      [DUE_DILIGENCE_URL]: dueDiligenceHtml,
      [MARGIN_REPORTING_URL]: marginReportingHtml
    });

    const pollRun = await runPollCycle({
      browserFetch,
      listingUrls: [LISTING_URL],
      findCircularBySourceHash: async (hash) => (hash === marginReportingHash ? makeCircular({ source_hash: marginReportingHash }) : null),
      findCircularsByTitleFuzzy: async () => [],
      invokeOrchestrator: async () => {
        throw new Error("orchestrator unavailable");
      },
      postOpsAlertWebhook: async () => undefined,
      rowCountHistory: new Map(),
      sleep: async () => undefined,
      maxRetries: 0
    });

    expect(pollRun.triggersEmitted).toBe(0);
    expect(pollRun.errors.some((e) => e.stage === "trigger_emit")).toBe(true);
  });
});
