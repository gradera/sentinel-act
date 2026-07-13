// Spec 11 §10 — "SLA scheduler cycle: seeded due-soon-and-breached mock
// response -> asserts correct chat.update/chat.postMessage/channel-post
// calls fire exactly once per item per state transition (no duplicate
// reminders on a second poll of the same still-due-soon item)."
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../card-model.js", () => ({
  assembleSlackCardModel: vi.fn(async (input: Record<string, unknown>) => ({
    obligationId: input.obligationId,
    circularTitle: input.circularTitle,
    category: input.category,
    summary: "summary",
    tier: input.tier,
    topTierReason: (input.tierReasons as string[])[0] ?? null,
    confidenceScore: input.confidenceScore,
    groundingScore: input.groundingScore,
    riskScore: input.riskScore,
    slaDueAt: input.slaDueAt,
    slaState: input.slaState,
    escalationReason: input.escalationReason,
    reviewGate: { kind: "tier_c", rationaleRequired: true, viewerSlot: "maker", status: "claimed_by_viewer", reveal: null },
    consoleDetailUrl: `${input.webConsoleBaseUrl}/queue/${input.obligationId}`,
    otherSlotFilled: false
  }))
}));

vi.mock("../slack-client.js", () => ({
  postMessage: vi.fn(async (input: Record<string, unknown>) => ({ ok: true, ts: `${input.channel}-ts`, channel: input.channel })),
  updateMessage: vi.fn(async () => ({ ok: true })),
  openView: vi.fn(async () => ({ ok: true, view: { id: "V1" } })),
  updateView: vi.fn(async () => ({ ok: true })),
  openConversation: vi.fn(async (input: { slackUserId: string }) => ({ ok: true, channel: { id: `D-${input.slackUserId}` } }))
}));

import { runSlaSchedulerCycle, type SlaBreachFeedPort, type SlaSchedulerDeps } from "../sla-reminder-scheduler.js";
import { postMessage, updateMessage } from "../slack-client.js";
import { SentCardStore } from "../delivery.js";
import { InMemorySlackUserMappingStore, DmChannelCache } from "../user-mapping.js";

describe("SLA reminder scheduler cycle (Spec 11 §10, FR-17–FR-21)", () => {
  let store: SentCardStore;
  let deps: SlaSchedulerDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new SentCardStore();
    store.setStaticFields("OBL-1", {
      circularTitle: "Stockbroker KYC re-verification deadline",
      category: "KYC",
      requirementText: "Brokers must re-verify KYC within 5 days.",
      tier: "C",
      tierReasons: ["Penalty-bearing"],
      confidenceScore: 0.8,
      groundingScore: 0.9,
      riskScore: 0.7,
      slaDueAt: "2026-07-13T12:00:00.000Z",
      slaState: "ok",
      escalationReason: null
    });
    store.record({ obligationId: "OBL-1", reviewerId: "officer-1", slackChannel: "D-U1", messageTs: "1.1" });

    deps = {
      botToken: "xoxb-test",
      webConsoleBaseUrl: "https://console.test",
      store,
      userMappingStore: new InMemorySlackUserMappingStore([{ reviewerId: "backup-1", slackUserId: "U-BACKUP", slackTeamId: "T1" }]),
      dmCache: new DmChannelCache(),
      feed: { getDueSoonAndBreached: vi.fn() } as unknown as SlaBreachFeedPort,
      escalationsChannelId: "C-ESCALATIONS"
    };
  });

  it("fires exactly one chat.update reminder for a due-soon item", async () => {
    (deps.feed.getDueSoonAndBreached as ReturnType<typeof vi.fn>).mockResolvedValue({
      dueSoon: [{ obligationId: "OBL-1", reviewerId: "officer-1", slaDueAt: "2026-07-13T12:00:00.000Z" }],
      breached: []
    });

    const result = await runSlaSchedulerCycle(deps);
    expect(result).toEqual({ dueSoonHandled: 1, breachedHandled: 0, skipped: false });
    expect(updateMessage).toHaveBeenCalledTimes(1);
    expect((updateMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ channel: "D-U1", ts: "1.1" });
  });

  it("does NOT fire a duplicate reminder when the feed stops returning the item on the next poll (dedup owned by the feed, §5.3)", async () => {
    const feedFn = deps.feed.getDueSoonAndBreached as ReturnType<typeof vi.fn>;
    feedFn.mockResolvedValueOnce({ dueSoon: [{ obligationId: "OBL-1", reviewerId: "officer-1", slaDueAt: "2026-07-13T12:00:00.000Z" }], breached: [] });
    feedFn.mockResolvedValueOnce({ dueSoon: [], breached: [] }); // Spec 08 marked it already-reminded

    await runSlaSchedulerCycle(deps);
    await runSlaSchedulerCycle(deps);

    expect(updateMessage).toHaveBeenCalledTimes(1); // not 2
  });

  it("breach handling: reassigns previous reviewer's card, DMs the backup reviewer, and posts to #sentinel-act-escalations", async () => {
    (deps.feed.getDueSoonAndBreached as ReturnType<typeof vi.fn>).mockResolvedValue({
      dueSoon: [],
      breached: [{ obligationId: "OBL-1", previousReviewerId: "officer-1", backupReviewerId: "backup-1", slaDueAt: "2026-07-13T12:00:00.000Z" }]
    });

    const result = await runSlaSchedulerCycle(deps);
    expect(result.breachedHandled).toBe(1);

    // (a) previous reviewer's card reassigned.
    expect(updateMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: "D-U1", ts: "1.1" }));

    // (b) new DM to backup reviewer.
    const postCalls = (postMessage as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(postCalls.some((c) => c.channel === "D-U-BACKUP")).toBe(true);

    // (c) escalations channel post.
    expect(postCalls.some((c) => c.channel === "C-ESCALATIONS")).toBe(true);
  });

  it("still posts to #sentinel-act-escalations even when the backup reviewer has no SlackUserMapping (FR-21, non-fatal DM failure)", async () => {
    deps.userMappingStore = new InMemorySlackUserMappingStore([]); // no mapping for backup-1
    (deps.feed.getDueSoonAndBreached as ReturnType<typeof vi.fn>).mockResolvedValue({
      dueSoon: [],
      breached: [{ obligationId: "OBL-1", previousReviewerId: "officer-1", backupReviewerId: "backup-1", slaDueAt: "2026-07-13T12:00:00.000Z" }]
    });

    let errorLogged = false;
    deps.onCycleError = () => {
      errorLogged = true;
    };

    await runSlaSchedulerCycle(deps);

    const postCalls = (postMessage as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(postCalls.some((c) => c.channel === "C-ESCALATIONS")).toBe(true);
    expect(errorLogged).toBe(true);
  });

  it("skips the cycle and logs (does not throw) when the feed itself is unavailable", async () => {
    (deps.feed.getDueSoonAndBreached as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("orchestrator unreachable"));
    let errorLogged = false;
    deps.onCycleError = () => {
      errorLogged = true;
    };

    const result = await runSlaSchedulerCycle(deps);
    expect(result).toEqual({ dueSoonHandled: 0, breachedHandled: 0, skipped: true });
    expect(errorLogged).toBe(true);
    expect(postMessage).not.toHaveBeenCalled();
    expect(updateMessage).not.toHaveBeenCalled();
  });
});
