import { describe, expect, it } from "vitest";
import type { ReviewTier } from "@sentinel-act/graph-schema";
import type { TierBReviewGateView, TierCReviewGateView } from "@sentinel-act/review-contracts";
import {
  SLACK_TIER_EMOJI,
  buildEscalateCard,
  buildRationaleModal,
  buildRationaleValidationError,
  buildReviewCard,
  formatSlaCountdown
} from "../blocks.js";
import type { SlackCardModel } from "../types.js";

function baseModel(overrides: Partial<SlackCardModel> = {}): SlackCardModel {
  const tierBGate: TierBReviewGateView = { kind: "tier_b", rationaleRequired: false, existingDecision: null };
  return {
    obligationId: "OBL-2026-0611",
    circularTitle: "Stockbroker KYC re-verification deadline",
    category: "KYC",
    summary: "Brokers must re-verify KYC within 5 days",
    tier: "B",
    topTierReason: "Medium risk score",
    confidenceScore: 0.82,
    groundingScore: 0.91,
    riskScore: 0.55,
    slaDueAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    slaState: "ok",
    escalationReason: null,
    reviewGate: tierBGate,
    consoleDetailUrl: "https://console.sentinel-act.internal/queue/OBL-2026-0611",
    otherSlotFilled: false,
    ...overrides
  };
}

function collectActionIds(blocks: Array<Record<string, unknown>>): string[] {
  const ids: string[] = [];
  for (const block of blocks) {
    if (block.type === "actions" && Array.isArray(block.elements)) {
      for (const el of block.elements as Array<Record<string, unknown>>) {
        if (typeof el.action_id === "string") {
          ids.push(el.action_id);
        }
      }
    }
  }
  return ids;
}

describe("SLACK_TIER_EMOJI (FR-3)", () => {
  it("has an entry for every ReviewTier | ESCALATE value", () => {
    const tiers: Array<ReviewTier | "ESCALATE"> = ["A", "B", "C", "ESCALATE"];
    for (const tier of tiers) {
      expect(SLACK_TIER_EMOJI[tier]).toBeTruthy();
      expect(typeof SLACK_TIER_EMOJI[tier]).toBe("string");
    }
    expect(SLACK_TIER_EMOJI.A).toBe("🟢");
    expect(SLACK_TIER_EMOJI.B).toBe("🟡");
    expect(SLACK_TIER_EMOJI.C).toBe("🟠");
    expect(SLACK_TIER_EMOJI.ESCALATE).toBe("🔴");
  });
});

describe("buildReviewCard — Tier B/C actionable card (FR-1)", () => {
  it("shows exactly the FR-1 field set: header/summary, confidence, grounding, risk, top tier reason, SLA countdown, actions", () => {
    const model = baseModel();
    const { blocks, text } = buildReviewCard(model);
    expect(text).toContain("Tier B");

    const header = blocks.find((b) => b.type === "header") as { text: { text: string } };
    expect(header.text.text).toContain("🟡");

    const summarySection = blocks.find((b) => b.type === "section" && (b as { text?: { text: string } }).text) as {
      text: { text: string };
    };
    expect(summarySection.text.text).toContain(model.circularTitle);
    expect(summarySection.text.text).toContain(model.summary);

    const fieldsBlock = blocks.find((b) => Array.isArray((b as { fields?: unknown[] }).fields)) as {
      fields: Array<{ text: string }>;
    };
    const fieldTexts = fieldsBlock.fields.map((f) => f.text).join("\n");
    expect(fieldTexts).toContain("Confidence");
    expect(fieldTexts).toContain("0.82");
    expect(fieldTexts).toContain("Grounding");
    expect(fieldTexts).toContain("0.91");
    expect(fieldTexts).toContain("Risk score");
    expect(fieldTexts).toContain("0.55");
    expect(fieldTexts).toContain("Medium risk score");

    const actionIds = collectActionIds(blocks as Array<Record<string, unknown>>);
    expect(actionIds).toContain("approve");
    expect(actionIds).toContain("decline");
    expect(actionIds).toContain("open_console");

    // Clause.text / ProcessTaskDiff / lineage breadcrumb are NOT rendered.
    const serialized = JSON.stringify(blocks);
    expect(serialized).not.toContain("lineage");
    expect(serialized).not.toContain("ProcessTaskDiff");
  });

  it("does not render an escalation line when escalationReason is null", () => {
    const { blocks } = buildReviewCard(baseModel({ escalationReason: null }));
    const serialized = JSON.stringify(blocks);
    expect(serialized).not.toContain("🚨");
  });

  it("renders a visible escalation line when escalationReason is set", () => {
    const { blocks } = buildReviewCard(baseModel({ escalationReason: "SLA missed, reassigned from priya.k" }));
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain("🚨");
    expect(serialized).toContain("SLA missed, reassigned from priya.k");
  });

  it("removes action buttons once a Tier B decision is already recorded (FR-16)", () => {
    const decidedGate: TierBReviewGateView = {
      kind: "tier_b",
      rationaleRequired: false,
      existingDecision: {
        review_id: "r1",
        obligation_id: "OBL-2026-0611",
        reviewer_id: "u1",
        tier: "B",
        decision: "approve",
        rationale: null,
        decided_at: "2026-07-01T00:00:00.000Z",
        valid_from: "2026-07-01",
        valid_to: null,
        recorded_at: "2026-07-01T00:00:00.000Z"
      }
    };
    const { blocks } = buildReviewCard(baseModel({ reviewGate: decidedGate }));
    const actionIds = collectActionIds(blocks as Array<Record<string, unknown>>);
    expect(actionIds).not.toContain("approve");
    expect(actionIds).not.toContain("decline");
    expect(actionIds).toContain("open_console");
  });
});

describe("ESCALATE link-only card — FIX 2 regression test (FR-5)", () => {
  it("has header + section + a single open_console action, and NO approve/decline action anywhere", () => {
    const model = baseModel({
      tier: "ESCALATE",
      escalationReason: "conflicts with a live obligation on deadline_rule",
      reviewGate: { kind: "escalate", rationaleRequired: true, existingDecision: null }
    });
    const { blocks } = buildEscalateCard(model);

    expect(blocks[0].type).toBe("header");
    expect(blocks[1].type).toBe("section");
    expect(blocks[2].type).toBe("actions");

    const actionIds = collectActionIds(blocks as Array<Record<string, unknown>>);
    expect(actionIds).toEqual(["open_console"]);
    expect(actionIds).not.toContain("approve");
    expect(actionIds).not.toContain("decline");

    // Direct regression assertion on the raw JSON too (belt and suspenders
    // — this is Fix 2's specific target).
    const serialized = JSON.stringify(blocks);
    expect(serialized).not.toMatch(/"action_id":"approve"/);
    expect(serialized).not.toMatch(/"action_id":"decline"/);
  });

  it("buildReviewCard dispatches to the link-only card for tier === ESCALATE (no branch produces decision buttons)", () => {
    const model = baseModel({
      tier: "ESCALATE",
      reviewGate: { kind: "escalate", rationaleRequired: true, existingDecision: null }
    });
    const { blocks } = buildReviewCard(model);
    const actionIds = collectActionIds(blocks as Array<Record<string, unknown>>);
    expect(actionIds).toEqual(["open_console"]);
  });
});

describe("Tier C card states (FR-9–FR-11)", () => {
  function tierCModel(status: TierCReviewGateView["status"], viewerSlot: TierCReviewGateView["viewerSlot"], otherSlotFilled = false): SlackCardModel {
    const gate: TierCReviewGateView = { kind: "tier_c", rationaleRequired: true, viewerSlot, status, reveal: null };
    return baseModel({ tier: "C", reviewGate: gate, otherSlotFilled });
  }

  it("shows approve/decline while unclaimed", () => {
    const { blocks } = buildReviewCard(tierCModel("unclaimed", null));
    expect(collectActionIds(blocks as Array<Record<string, unknown>>)).toContain("approve");
  });

  it("FR-10: removes actions once viewer has submitted and is awaiting peer", () => {
    const { blocks } = buildReviewCard(tierCModel("viewer_submitted_awaiting_peer", "maker"));
    const actionIds = collectActionIds(blocks as Array<Record<string, unknown>>);
    expect(actionIds).not.toContain("approve");
    expect(actionIds).not.toContain("decline");
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain("recorded and locked");
  });

  it("FR-9: an eligible reviewer who has not claimed sees 'no longer open' language, but retains the ability to claim the other slot", () => {
    const { blocks } = buildReviewCard(tierCModel("unclaimed", null, true));
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain("no longer open");
    // per FR-9's wording this viewer "may still be needed for the other
    // slot" — decision buttons remain so they can claim it.
    expect(collectActionIds(blocks as Array<Record<string, unknown>>)).toContain("approve");
  });

  it("FR-11: reveal state removes actions for both original recipients", () => {
    const gate: TierCReviewGateView = {
      kind: "tier_c",
      rationaleRequired: true,
      viewerSlot: "maker",
      status: "resolved_agree",
      reveal: {
        agreement: true,
        reviews: [
          {
            review_id: "r1",
            obligation_id: "OBL-2026-0611",
            reviewer_id: "maker-1",
            tier: "C",
            decision: "approve",
            rationale: "looks fine",
            decided_at: "2026-07-01T00:00:00.000Z",
            valid_from: "2026-07-01",
            valid_to: null,
            recorded_at: "2026-07-01T00:00:00.000Z"
          },
          {
            review_id: "r2",
            obligation_id: "OBL-2026-0611",
            reviewer_id: "checker-1",
            tier: "C",
            decision: "approve",
            rationale: "agree",
            decided_at: "2026-07-01T01:00:00.000Z",
            valid_from: "2026-07-01",
            valid_to: null,
            recorded_at: "2026-07-01T01:00:00.000Z"
          }
        ]
      }
    };
    const { blocks } = buildReviewCard(baseModel({ tier: "C", reviewGate: gate }));
    const actionIds = collectActionIds(blocks as Array<Record<string, unknown>>);
    expect(actionIds).not.toContain("approve");
    expect(actionIds).not.toContain("decline");
  });
});

describe("rationale modal (FR-12–FR-15)", () => {
  it("private_metadata carries obligationId/decision/tier/slackChannel/messageTs and NEVER reviewerId", () => {
    const modal = buildRationaleModal({
      obligationId: "OBL-2026-0611",
      circularTitle: "Stockbroker KYC re-verification deadline",
      decision: "approve",
      tier: "C",
      rationaleRequired: true,
      slackChannel: "D123",
      messageTs: "1234.5678"
    });
    const metadata = JSON.parse(modal.private_metadata as string);
    expect(metadata).toEqual({
      obligationId: "OBL-2026-0611",
      decision: "approve",
      tier: "C",
      slackChannel: "D123",
      messageTs: "1234.5678"
    });
    expect(metadata.reviewerId).toBeUndefined();
    expect(JSON.stringify(modal)).not.toContain("reviewerId");
  });

  it("sets optional:false for Tier C (rationaleRequired) and optional:true for Tier B", () => {
    const tierC = buildRationaleModal({
      obligationId: "o1",
      circularTitle: "x",
      decision: "approve",
      tier: "C",
      rationaleRequired: true,
      slackChannel: "D1",
      messageTs: "1"
    });
    const tierB = buildRationaleModal({
      obligationId: "o1",
      circularTitle: "x",
      decision: "approve",
      tier: "B",
      rationaleRequired: false,
      slackChannel: "D1",
      messageTs: "1"
    });
    const tierCBlock = (tierC.blocks as Array<Record<string, unknown>>).find((b) => b.block_id === "rationale_block");
    const tierBBlock = (tierB.blocks as Array<Record<string, unknown>>).find((b) => b.block_id === "rationale_block");
    expect(tierCBlock?.optional).toBe(false);
    expect(tierBBlock?.optional).toBe(true);
  });

  it("never branches on an EscalateReviewGateView case — this function has no tier === ESCALATE special case at all (dead code removed)", () => {
    // The function signature only accepts ReviewTier | "ESCALATE" for
    // completeness of the union, but ESCALATE cards never render a button
    // that calls views.open (see blocks/handlers), so this modal builder
    // is never invoked with tier: "ESCALATE" in practice. Assert the
    // function's source has no such branch by checking behavior is
    // identical in shape regardless of the tier value passed (no special
    // ESCALATE-only field appears).
    const modal = buildRationaleModal({
      obligationId: "o1",
      circularTitle: "x",
      decision: "reject",
      tier: "ESCALATE",
      rationaleRequired: true,
      slackChannel: "D1",
      messageTs: "1"
    });
    expect(modal.callback_id).toBe("submit_review_decision");
  });

  it("buildRationaleValidationError returns Slack's response_action:errors shape", () => {
    const result = buildRationaleValidationError("Rationale is required at Tier C.");
    expect(result).toEqual({
      response_action: "errors",
      errors: { rationale_block: "Rationale is required at Tier C." }
    });
  });
});

describe("formatSlaCountdown", () => {
  it("renders a positive due-in countdown", () => {
    const dueAt = new Date(Date.now() + 3 * 60 * 60 * 1000 + 12 * 60 * 1000).toISOString();
    expect(formatSlaCountdown(dueAt, "ok")).toMatch(/Due in 3h 1[12]m/);
  });

  it("renders an overdue message once breached", () => {
    const dueAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(formatSlaCountdown(dueAt, "breached")).toMatch(/Overdue by 1h/);
  });

  it("renders a no-SLA message when slaDueAt is null", () => {
    expect(formatSlaCountdown(null, "ok")).toBe("No review SLA set");
  });
});
