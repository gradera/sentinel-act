// Spec 11 FR-5's server-side backstop: "reject a crafted decision:'approve'
// action payload for an ESCALATE item with the same 403
// ACTION_NOT_ALLOWED_FOR_TIER semantics as Spec 09, in case a stale
// cached card is interacted with after routing changed underneath it."
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeBackend = vi.hoisted(() => ({ instance: null as unknown as import("./fake-orchestrator-backend.js").FakeOrchestratorBackend }));

vi.mock("../orchestrator-client.js", async () => {
  const { FakeOrchestratorBackend } = await import("./fake-orchestrator-backend.js");
  const { ResumeReviewStepError } = await import("../resume-review-step-error.js");
  fakeBackend.instance = new FakeOrchestratorBackend();
  return {
    getReviewGate: (obligationId: string, reviewerId: string, tier: "B" | "C" | "ESCALATE") => fakeBackend.instance.getReviewGate(obligationId, reviewerId, tier),
    getClaimSlots: (obligationId: string) => fakeBackend.instance.getClaimSlots(obligationId),
    claimReviewSlot: (obligationId: string, reviewerId: string) => fakeBackend.instance.claimReviewSlot(obligationId, reviewerId),
    resumeReviewStep: (input: unknown) => fakeBackend.instance.resumeReviewStep(input as never),
    ResumeReviewStepError
  };
});

vi.mock("../slack-client.js", () => ({
  postMessage: vi.fn(async () => ({ ok: true, ts: "1.1", channel: "D1" })),
  updateMessage: vi.fn(async () => ({ ok: true })),
  openView: vi.fn(async () => ({ ok: true, view: { id: "V1" } })),
  updateView: vi.fn(async () => ({ ok: true })),
  openConversation: vi.fn(async () => ({ ok: true, channel: { id: "D1" } }))
}));

import { ActionNotAllowedForTierError, handleBlockActionsPayload } from "../handlers/block-actions.js";
import { openView } from "../slack-client.js";
import { SentCardStore, deliverSingleRecipientCard } from "../delivery.js";
import { InMemorySlackUserMappingStore, DmChannelCache } from "../user-mapping.js";
import type { SlackBlockActionsPayload } from "../slack-payloads.js";

describe("FR-5: ESCALATE items reject crafted approve/decline actions with 403 ACTION_NOT_ALLOWED_FOR_TIER", () => {
  let deps: Parameters<typeof handleBlockActionsPayload>[1];

  beforeEach(async () => {
    const { FakeOrchestratorBackend } = await import("./fake-orchestrator-backend.js");
    fakeBackend.instance = new FakeOrchestratorBackend();
    vi.clearAllMocks();

    const store = new SentCardStore();
    const userMappingStore = new InMemorySlackUserMappingStore([{ reviewerId: "senior-a", slackUserId: "U-A", slackTeamId: "T1" }]);
    deps = { botToken: "xoxb-test", webConsoleBaseUrl: "https://console.test", store, userMappingStore, dmCache: new DmChannelCache() };

    await deliverSingleRecipientCard(
      "OBL-ESC-1",
      "senior-a",
      {
        circularTitle: "Contradiction example",
        category: "KYC",
        requirementText: "Conflicts with a live obligation.",
        tier: "ESCALATE",
        tierReasons: ["Contradiction with live obligation"],
        confidenceScore: 0.7,
        groundingScore: 0.4,
        riskScore: 0.9,
        slaDueAt: null,
        slaState: "ok",
        escalationReason: "conflicts with a live obligation on deadline_rule"
      },
      deps
    );
  });

  it("throws ActionNotAllowedForTierError and makes NO views.open call for a stale/crafted approve payload", async () => {
    const payload: SlackBlockActionsPayload = {
      type: "block_actions",
      user: { id: "U-A" },
      trigger_id: "trigger-x",
      actions: [{ action_id: "approve", block_id: "review_actions", type: "button", value: JSON.stringify({ obligationId: "OBL-ESC-1", decision: "approve" }) }],
      container: { channel_id: "D1", message_ts: "1.1" }
    };

    await expect(handleBlockActionsPayload(payload, deps)).rejects.toThrow(ActionNotAllowedForTierError);
    await expect(handleBlockActionsPayload(payload, deps)).rejects.toMatchObject({ code: "ACTION_NOT_ALLOWED_FOR_TIER" });
    expect(openView).not.toHaveBeenCalled();
  });

  it("same rejection for a crafted decline payload", async () => {
    const payload: SlackBlockActionsPayload = {
      type: "block_actions",
      user: { id: "U-A" },
      trigger_id: "trigger-y",
      actions: [{ action_id: "decline", block_id: "review_actions", type: "button", value: JSON.stringify({ obligationId: "OBL-ESC-1", decision: "reject" }) }],
      container: { channel_id: "D1", message_ts: "1.1" }
    };
    await expect(handleBlockActionsPayload(payload, deps)).rejects.toThrow(ActionNotAllowedForTierError);
    expect(openView).not.toHaveBeenCalled();
  });

  it("open_console remains a no-op action (not rejected — it is a URL button, not a decision)", async () => {
    const payload: SlackBlockActionsPayload = {
      type: "block_actions",
      user: { id: "U-A" },
      trigger_id: "trigger-z",
      actions: [{ action_id: "open_console", block_id: "review_actions", type: "button" }],
      container: { channel_id: "D1", message_ts: "1.1" }
    };
    const result = await handleBlockActionsPayload(payload, deps);
    expect(result.outcome).toBe("no_op");
  });
});
