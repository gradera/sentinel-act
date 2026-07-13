// Spec 11 §10 — "Full Tier C independence path (the critical test for
// this unit): two simulated reviewer flows against the same
// obligationId, asserting via captured outbound request bodies that
// reviewer B's messages never contain reviewer A's decision fields before
// B's own submission, then asserting the reveal fires correctly for both
// after both submit." Also covers NFR-Security-1 and Acceptance Criteria
// #2/#3.
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

// Captures EVERY outbound chat.postMessage/chat.update REQUEST BODY,
// tagged by which Slack channel (i.e. which recipient's DM) it went to —
// this is the raw-request-body capture NFR-Security-1 requires ("MUST be
// verifiable by capturing this unit's outbound chat.postMessage/
// chat.update request bodies in a test, not by inspecting rendered Slack
// UI").
const outboundByChannel = vi.hoisted(() => new Map<string, Array<Record<string, unknown>>>());

function recordOutbound(channel: string, body: Record<string, unknown>): void {
  const list = outboundByChannel.get(channel) ?? [];
  list.push(body);
  outboundByChannel.set(channel, list);
}

vi.mock("../slack-client.js", () => {
  return {
    postMessage: vi.fn(async (input: Record<string, unknown>) => {
      recordOutbound(input.channel as string, input);
      const list = outboundByChannel.get(input.channel as string)!;
      return { ok: true, ts: `${input.channel}-${list.length}`, channel: input.channel };
    }),
    updateMessage: vi.fn(async (input: Record<string, unknown>) => {
      recordOutbound(input.channel as string, input);
      return { ok: true };
    }),
    openView: vi.fn(async () => ({ ok: true, view: { id: "V1" } })),
    updateView: vi.fn(async () => ({ ok: true })),
    openConversation: vi.fn(async (input: { slackUserId: string }) => ({ ok: true, channel: { id: `D-${input.slackUserId}` } }))
  };
});

import { handleBlockActionsPayload } from "../handlers/block-actions.js";
import { processViewSubmission } from "../handlers/view-submissions.js";
import { deliverTierCFanOut, SentCardStore } from "../delivery.js";
import { InMemorySlackUserMappingStore, DmChannelCache } from "../user-mapping.js";
import type { SlackBlockActionsPayload, SlackViewSubmissionPayload } from "../slack-payloads.js";

const OBLIGATION_ID = "OBL-2026-0611";
const REVIEWER_A = "senior-a";
const REVIEWER_B = "senior-b";
const SLACK_A = "U-A";
const SLACK_B = "U-B";

describe("Tier C independence in Slack — the critical test (Spec 11 §10, NFR-Security-1, AC #2/#3)", () => {
  let store: SentCardStore;
  let userMappingStore: InMemorySlackUserMappingStore;
  let dmCache: DmChannelCache;
  let deps: Parameters<typeof handleBlockActionsPayload>[1];

  beforeEach(async () => {
    outboundByChannel.clear();
    const { FakeOrchestratorBackend } = await import("./fake-orchestrator-backend.js");
    fakeBackend.instance = new FakeOrchestratorBackend();

    store = new SentCardStore();
    userMappingStore = new InMemorySlackUserMappingStore([
      { reviewerId: REVIEWER_A, slackUserId: SLACK_A, slackTeamId: "T1" },
      { reviewerId: REVIEWER_B, slackUserId: SLACK_B, slackTeamId: "T1" }
    ]);
    dmCache = new DmChannelCache();
    deps = { botToken: "xoxb-test", webConsoleBaseUrl: "https://console.test", store, userMappingStore, dmCache };

    await deliverTierCFanOut(
      OBLIGATION_ID,
      [REVIEWER_A, REVIEWER_B],
      {
        circularTitle: "Stockbroker KYC re-verification deadline",
        category: "KYC",
        requirementText: "Brokers must re-verify KYC within 5 days of a flagged mismatch.",
        tier: "C",
        tierReasons: ["Penalty-bearing, overwrites a live obligation"],
        confidenceScore: 0.82,
        groundingScore: 0.91,
        riskScore: 0.78,
        slaDueAt: null,
        slaState: "ok",
        escalationReason: null
      },
      deps
    );
  });

  function channelBodies(channel: string): Array<Record<string, unknown>> {
    return outboundByChannel.get(channel) ?? [];
  }

  function serializedBodiesFor(channel: string): string {
    return JSON.stringify(channelBodies(channel));
  }

  it("delivers one independent DM per eligible reviewer (FR-7) — never a shared message", () => {
    expect(channelBodies(`D-${SLACK_A}`)).toHaveLength(1);
    expect(channelBodies(`D-${SLACK_B}`)).toHaveLength(1);
  });

  it("reviewer A claims and approves with a rationale; reviewer B's outbound bodies at every point before B submits contain none of A's decision fields (NFR-Security-1, AC #2)", async () => {
    // Reviewer A clicks Approve.
    const claimAction: SlackBlockActionsPayload = {
      type: "block_actions",
      user: { id: SLACK_A },
      trigger_id: "trigger-A",
      actions: [{ action_id: "approve", block_id: "review_actions", type: "button", value: JSON.stringify({ obligationId: OBLIGATION_ID, decision: "approve" }) }],
      container: { channel_id: `D-${SLACK_A}`, message_ts: channelBodies(`D-${SLACK_A}`)[0].ts as string | undefined ?? `D-${SLACK_A}-1` }
    };
    const claimResult = await handleBlockActionsPayload(claimAction, deps);
    expect(claimResult.outcome).toBe("modal_opened");

    // At this point reviewer A has only claimed, not decided yet — check
    // B's channel has no decision leak (nothing to leak yet, but this
    // also proves the claim-refresh path (FR-9) never writes decision
    // fields).
    expect(serializedBodiesFor(`D-${SLACK_B}`)).not.toMatch(/"decision":"approve"/);
    expect(serializedBodiesFor(`D-${SLACK_B}`)).not.toContain(REVIEWER_A);

    // Reviewer A submits Approve with a rationale via the modal.
    const submissionA: SlackViewSubmissionPayload = {
      type: "view_submission",
      user: { id: SLACK_A },
      view: {
        id: "V-A",
        callback_id: "submit_review_decision",
        private_metadata: JSON.stringify({ obligationId: OBLIGATION_ID, decision: "approve", tier: "C", slackChannel: `D-${SLACK_A}`, messageTs: "ts-a" }),
        state: { values: { rationale_block: { rationale_input: { type: "plain_text_input", value: "Looks correct, matches the circular text." } } } }
      }
    };
    const processResultA = await processViewSubmission(submissionA, deps);
    expect(processResultA.outcome).toBe("success");

    // THE core assertion: every raw outbound body ever sent to reviewer
    // B's channel — across the ENTIRE flow so far — contains no trace of
    // reviewer A's decision, rationale, reviewer_id, or decided_at.
    const bBodies = serializedBodiesFor(`D-${SLACK_B}`);
    expect(bBodies).not.toMatch(/"decision":"approve"/);
    expect(bBodies).not.toContain("Looks correct, matches the circular text");
    expect(bBodies).not.toContain(REVIEWER_A);
    expect(bBodies).not.toContain("senior-a");

    // Reviewer A's OWN card, meanwhile, correctly reflects "recorded and
    // locked, awaiting a second independent review" (FR-10).
    const aLastBody = channelBodies(`D-${SLACK_A}`)[channelBodies(`D-${SLACK_A}`).length - 1];
    expect(JSON.stringify(aLastBody)).toContain("recorded and locked");

    // And reviewer B's card, from B's own recomputed gate (never copied
    // from A's), still shows an open decision path (unclaimed or
    // claimed_by_viewer at most, no decision content).
    const gateForB = await fakeBackend.instance.getReviewGate(OBLIGATION_ID, REVIEWER_B, "C");
    expect(gateForB.kind === "tier_c" && gateForB.status).not.toMatch(/resolved_/);
  });

  it("reviewer B then independently claims and submits reject; both reviewers' DMs reveal both HumanReview records and Obligation.status becomes escalated (AC #3, FR-11)", async () => {
    // A approves first (same as above, condensed).
    const submissionA: SlackViewSubmissionPayload = {
      type: "view_submission",
      user: { id: SLACK_A },
      view: {
        id: "V-A",
        callback_id: "submit_review_decision",
        private_metadata: JSON.stringify({ obligationId: OBLIGATION_ID, decision: "approve", tier: "C", slackChannel: `D-${SLACK_A}`, messageTs: "ts-a" }),
        state: { values: { rationale_block: { rationale_input: { type: "plain_text_input", value: "Approve rationale from A." } } } }
      }
    };
    await handleBlockActionsPayload(
      {
        type: "block_actions",
        user: { id: SLACK_A },
        trigger_id: "trigger-A",
        actions: [{ action_id: "approve", block_id: "review_actions", type: "button", value: JSON.stringify({ obligationId: OBLIGATION_ID, decision: "approve" }) }],
        container: { channel_id: `D-${SLACK_A}`, message_ts: "ts-a" }
      },
      deps
    );
    await processViewSubmission(submissionA, deps);

    // B independently claims the other slot and submits Reject.
    const claimB = await handleBlockActionsPayload(
      {
        type: "block_actions",
        user: { id: SLACK_B },
        trigger_id: "trigger-B",
        actions: [{ action_id: "decline", block_id: "review_actions", type: "button", value: JSON.stringify({ obligationId: OBLIGATION_ID, decision: "reject" }) }],
        container: { channel_id: `D-${SLACK_B}`, message_ts: "ts-b" }
      },
      deps
    );
    expect(claimB.outcome).toBe("modal_opened");

    const claimSlots = await fakeBackend.instance.getClaimSlots(OBLIGATION_ID);
    expect(claimSlots).toEqual({ maker: REVIEWER_A, checker: REVIEWER_B });

    const submissionB: SlackViewSubmissionPayload = {
      type: "view_submission",
      user: { id: SLACK_B },
      view: {
        id: "V-B",
        callback_id: "submit_review_decision",
        private_metadata: JSON.stringify({ obligationId: OBLIGATION_ID, decision: "reject", tier: "C", slackChannel: `D-${SLACK_B}`, messageTs: "ts-b" }),
        state: { values: { rationale_block: { rationale_input: { type: "plain_text_input", value: "Disagree — deadline mismatch." } } } }
      }
    };
    const processResultB = await processViewSubmission(submissionB, deps);
    expect(processResultB.outcome).toBe("success");

    // Both original recipients' own stored messages now show the reveal.
    const aLast = channelBodies(`D-${SLACK_A}`)[channelBodies(`D-${SLACK_A}`).length - 1];
    const bLast = channelBodies(`D-${SLACK_B}`)[channelBodies(`D-${SLACK_B}`).length - 1];
    expect(JSON.stringify(aLast)).toContain("escalated (disagreement)");
    expect(JSON.stringify(bLast)).toContain("escalated (disagreement)");

    // Underlying Obligation.status is "escalated" (resolved_disagree).
    const gateFinalA = await fakeBackend.instance.getReviewGate(OBLIGATION_ID, REVIEWER_A, "C");
    expect(gateFinalA.kind === "tier_c" && gateFinalA.status).toBe("resolved_disagree");
    expect(processResultB).toEqual({ outcome: "success" });
  });

  it("captures each recipient's card from an independently-computed getReviewGate call, never a shared/cached value (FR-6)", async () => {
    const callsForA = fakeBackend.instance.getReviewGateCalls.filter((c) => c.reviewerId === REVIEWER_A);
    const callsForB = fakeBackend.instance.getReviewGateCalls.filter((c) => c.reviewerId === REVIEWER_B);
    expect(callsForA.length).toBeGreaterThan(0);
    expect(callsForB.length).toBeGreaterThan(0);
    // Every call was made with the correct obligationId/tier for that
    // specific reviewer — no cross-contamination of args.
    for (const call of [...callsForA, ...callsForB]) {
      expect(call.obligationId).toBe(OBLIGATION_ID);
      expect(call.tier).toBe("C");
    }
  });
});
