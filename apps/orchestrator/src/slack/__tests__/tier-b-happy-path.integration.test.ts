// Spec 11 §10 Integration test: "Full Tier B happy path: simulated
// block_actions (approve) -> views.open called with correct trigger_id
// and modal blocks -> simulated view_submission -> resumeReviewStep
// called with correct args -> chat.update called on the original message
// with confirmation copy."
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeBackend = vi.hoisted(() => {
  return { instance: null as unknown as import("./fake-orchestrator-backend.js").FakeOrchestratorBackend };
});

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

const slackCalls = vi.hoisted(() => ({
  postMessage: [] as Array<Record<string, unknown>>,
  updateMessage: [] as Array<Record<string, unknown>>,
  openView: [] as Array<Record<string, unknown>>
}));

vi.mock("../slack-client.js", () => {
  return {
    postMessage: vi.fn(async (input: Record<string, unknown>) => {
      slackCalls.postMessage.push(input);
      return { ok: true, ts: `1000.${slackCalls.postMessage.length}`, channel: input.channel };
    }),
    updateMessage: vi.fn(async (input: Record<string, unknown>) => {
      slackCalls.updateMessage.push(input);
      return { ok: true };
    }),
    openView: vi.fn(async (input: Record<string, unknown>) => {
      slackCalls.openView.push(input);
      return { ok: true, view: { id: "V1" } };
    }),
    updateView: vi.fn(async () => ({ ok: true })),
    openConversation: vi.fn(async (input: { slackUserId: string }) => ({ ok: true, channel: { id: `D-${input.slackUserId}` } }))
  };
});

import { handleBlockActionsPayload } from "../handlers/block-actions.js";
import { processViewSubmission, validateRationaleSubmission } from "../handlers/view-submissions.js";
import { SentCardStore, deliverSingleRecipientCard } from "../delivery.js";
import { InMemorySlackUserMappingStore, DmChannelCache } from "../user-mapping.js";
import type { SlackBlockActionsPayload, SlackViewSubmissionPayload } from "../slack-payloads.js";

describe("Full Tier B happy path (Spec 11 §10)", () => {
  let store: SentCardStore;
  let userMappingStore: InMemorySlackUserMappingStore;
  let dmCache: DmChannelCache;
  let deps: Parameters<typeof handleBlockActionsPayload>[1];

  beforeEach(async () => {
    slackCalls.postMessage.length = 0;
    slackCalls.updateMessage.length = 0;
    slackCalls.openView.length = 0;
    const { FakeOrchestratorBackend } = await import("./fake-orchestrator-backend.js");
    fakeBackend.instance = new FakeOrchestratorBackend();

    store = new SentCardStore();
    userMappingStore = new InMemorySlackUserMappingStore([{ reviewerId: "officer-1", slackUserId: "U1", slackTeamId: "T1" }]);
    dmCache = new DmChannelCache();
    deps = {
      botToken: "xoxb-test",
      webConsoleBaseUrl: "https://console.test",
      store,
      userMappingStore,
      dmCache
    };

    await deliverSingleRecipientCard(
      "OBL-1",
      "officer-1",
      {
        circularTitle: "Stockbroker KYC re-verification deadline",
        category: "KYC",
        requirementText: "Brokers must re-verify KYC within 5 days of a flagged mismatch.",
        tier: "B",
        tierReasons: ["Medium risk score"],
        confidenceScore: 0.8,
        groundingScore: 0.9,
        riskScore: 0.5,
        slaDueAt: null,
        slaState: "ok",
        escalationReason: null
      },
      deps
    );
  });

  it("delivers exactly one initial card", () => {
    expect(slackCalls.postMessage).toHaveLength(1);
    expect(slackCalls.postMessage[0].channel).toBe("D-U1");
  });

  it("opens the rationale modal with correct trigger_id and modal blocks on approve click, then resumes and confirms on submission", async () => {
    const blockActionsPayload: SlackBlockActionsPayload = {
      type: "block_actions",
      user: { id: "U1" },
      trigger_id: "trigger-123",
      actions: [{ action_id: "approve", block_id: "review_actions", type: "button", value: JSON.stringify({ obligationId: "OBL-1", decision: "approve" }) }],
      container: { channel_id: "D-U1", message_ts: "1000.1" }
    };

    const result = await handleBlockActionsPayload(blockActionsPayload, deps);
    expect(result.outcome).toBe("modal_opened");
    expect(slackCalls.openView).toHaveLength(1);
    expect(slackCalls.openView[0].triggerId).toBe("trigger-123");
    const modal = slackCalls.openView[0].view as { callback_id: string; blocks: unknown[] };
    expect(modal.callback_id).toBe("submit_review_decision");
    expect(Array.isArray(modal.blocks)).toBe(true);

    // Simulate the view_submission — Tier B accepts an empty rationale.
    const viewSubmissionPayload: SlackViewSubmissionPayload = {
      type: "view_submission",
      user: { id: "U1" },
      view: {
        id: "V1",
        callback_id: "submit_review_decision",
        private_metadata: JSON.stringify({ obligationId: "OBL-1", decision: "approve", tier: "B", slackChannel: "D-U1", messageTs: "1000.1" }),
        state: { values: { rationale_block: { rationale_input: { type: "plain_text_input", value: "" } } } }
      }
    };

    const validation = validateRationaleSubmission(viewSubmissionPayload, "B");
    expect(validation.valid).toBe(true);

    const processResult = await processViewSubmission(viewSubmissionPayload, deps);
    expect(processResult.outcome).toBe("success");

    // resumeReviewStep was called with correct args (via the fake backend
    // — assert the resulting graph state instead of a mock call log,
    // since the fake IS the "resumeReviewStep called with correct args"
    // assertion surface here).
    const gate = await fakeBackend.instance.getReviewGate("OBL-1", "officer-1", "B");
    expect(gate.kind).toBe("tier_b");
    expect(gate.kind === "tier_b" && gate.existingDecision?.decision).toBe("approve");

    // chat.update called on the ORIGINAL message with confirmation copy.
    expect(slackCalls.updateMessage.length).toBeGreaterThanOrEqual(1);
    const lastUpdate = slackCalls.updateMessage[slackCalls.updateMessage.length - 1];
    expect(lastUpdate.channel).toBe("D-U1");
    expect(lastUpdate.ts).toBe("1000.1");
    expect(JSON.stringify(lastUpdate.blocks)).toContain("Decision recorded");
  });

  it("rejects an empty Tier C rationale but accepts an empty Tier B rationale (FR-14)", () => {
    const tierBPayload: SlackViewSubmissionPayload = {
      type: "view_submission",
      user: { id: "U1" },
      view: {
        id: "V1",
        callback_id: "submit_review_decision",
        private_metadata: "{}",
        state: { values: { rationale_block: { rationale_input: { type: "plain_text_input", value: "" } } } }
      }
    };
    expect(validateRationaleSubmission(tierBPayload, "B").valid).toBe(true);
    expect(validateRationaleSubmission(tierBPayload, "C").valid).toBe(false);
    expect(validateRationaleSubmission(tierBPayload, "C").valid === false && (validateRationaleSubmission(tierBPayload, "C") as { response: unknown }).response).toBeTruthy();
  });
});
