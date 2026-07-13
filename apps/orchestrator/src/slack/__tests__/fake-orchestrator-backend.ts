// Test double implementing Spec 08's proposed getReviewGate/
// claimReviewSlot/resumeReviewStep contract (§5.3) — used to vi.mock
// "../orchestrator-client.js" in every integration test in this
// directory. This lets the Slack handler/delivery code under test run
// against realistic Tier B/C independence semantics (mirroring
// orchestrator.logic.ts's real deriveReviewGateView +
// monitoring-and-audit.agent.ts's real getReviewsVisibleTo redaction
// rule) WITHOUT importing orchestrator.workflow.ts — which transitively
// imports "@mastra/core/workflows", unresolvable in this sandbox (a
// pre-existing, unrelated environment issue: apps/orchestrator/node_modules/
// @mastra/core is a symlink into a DIFFERENT session's mount path,
// confirmed via `stat`, not something introduced by this unit).
//
// This fake is deliberately a faithful re-implementation of the
// documented redaction contract (§4 ReviewGateView's own doc comment:
// "reveal is only ever non-null when status starts with resolved_ ...
// after BOTH reviewers have submitted") — it exists to prove THIS unit's
// handler/delivery code respects whatever the real backend tells it, not
// to re-test Spec 08/07's own correctness (that is Spec 07/08's own test
// suites' job, exercised elsewhere in this repo).
import type { HumanReview, ObligationStatus, ReviewTier } from "@sentinel-act/graph-schema";
import type { ReviewGateView } from "@sentinel-act/review-contracts";
import { ResumeReviewStepError } from "../resume-review-step-error.js";
import type { ResumeReviewStepInput, ResumeReviewStepResult } from "../orchestrator-client.js";

let reviewIdCounter = 0;

export class FakeOrchestratorBackend {
  private readonly claims = new Map<string, { maker: string | null; checker: string | null }>();
  private readonly reviews = new Map<string, HumanReview[]>();

  /** Captures every outbound call this fake ever received — used by
   *  NFR-Security-1's test to assert on the SEQUENCE of getReviewGate
   *  calls (which reviewerId asked, what they got back), independent of
   *  what the Slack card renderer does with the result. */
  readonly getReviewGateCalls: Array<{ obligationId: string; reviewerId: string; tier: string; result: ReviewGateView }> = [];

  async getReviewGate(obligationId: string, reviewerId: string, tier: "B" | "C" | "ESCALATE"): Promise<ReviewGateView> {
    let result: ReviewGateView;
    if (tier === "ESCALATE") {
      result = { kind: "escalate", rationaleRequired: true, existingDecision: null };
    } else if (tier === "B") {
      const reviews = this.reviews.get(obligationId) ?? [];
      const mine = reviews.find((r) => r.reviewer_id === reviewerId) ?? null;
      result = { kind: "tier_b", rationaleRequired: false, existingDecision: mine };
    } else {
      const reviews = this.reviews.get(obligationId) ?? [];
      const visible = reviews.some((r) => r.reviewer_id === reviewerId) ? reviews : [];
      const claims = this.claims.get(obligationId) ?? { maker: null, checker: null };
      const viewerSlot: "maker" | "checker" | null = claims.maker === reviewerId ? "maker" : claims.checker === reviewerId ? "checker" : null;

      if (visible.length >= 2) {
        const agreement = visible[0].decision === visible[1].decision;
        result = { kind: "tier_c", rationaleRequired: true, viewerSlot, status: agreement ? "resolved_agree" : "resolved_disagree", reveal: { reviews: visible, agreement } };
      } else if (visible.length === 1) {
        result = { kind: "tier_c", rationaleRequired: true, viewerSlot, status: "viewer_submitted_awaiting_peer", reveal: null };
      } else {
        result = { kind: "tier_c", rationaleRequired: true, viewerSlot, status: viewerSlot ? "claimed_by_viewer" : "unclaimed", reveal: null };
      }
    }
    this.getReviewGateCalls.push({ obligationId, reviewerId, tier, result });
    return result;
  }

  async getClaimSlots(obligationId: string): Promise<{ maker: string | null; checker: string | null } | null> {
    return this.claims.get(obligationId) ?? null;
  }

  async claimReviewSlot(obligationId: string, reviewerId: string): Promise<{ ok: true; viewerSlot: "maker" | "checker" } | { ok: false; code: "SLOT_UNAVAILABLE" }> {
    const current = this.claims.get(obligationId) ?? { maker: null, checker: null };
    if (current.maker === reviewerId) {
      this.claims.set(obligationId, current);
      return { ok: true, viewerSlot: "maker" };
    }
    if (current.checker === reviewerId) {
      this.claims.set(obligationId, current);
      return { ok: true, viewerSlot: "checker" };
    }
    if (current.maker === null) {
      current.maker = reviewerId;
      this.claims.set(obligationId, current);
      return { ok: true, viewerSlot: "maker" };
    }
    if (current.checker === null) {
      current.checker = reviewerId;
      this.claims.set(obligationId, current);
      return { ok: true, viewerSlot: "checker" };
    }
    return { ok: false, code: "SLOT_UNAVAILABLE" };
  }

  async resumeReviewStep(input: ResumeReviewStepInput): Promise<ResumeReviewStepResult> {
    const reviews = this.reviews.get(input.obligationId) ?? [];
    if (reviews.some((r) => r.reviewer_id === input.reviewerId)) {
      throw new ResumeReviewStepError("ALREADY_DECIDED", `reviewer ${input.reviewerId} already decided on ${input.obligationId}.`);
    }
    if (input.tier === "C" && reviews.length >= 1) {
      const claims = this.claims.get(input.obligationId) ?? { maker: null, checker: null };
      if (claims.maker !== input.reviewerId && claims.checker !== input.reviewerId) {
        throw new ResumeReviewStepError("NOT_ASSIGNED", `reviewer ${input.reviewerId} does not hold a claimed slot on ${input.obligationId}.`);
      }
    }

    reviewIdCounter += 1;
    const wireTier: ReviewTier = input.tier === "ESCALATE" ? "C" : input.tier;
    const review: HumanReview = {
      review_id: `fake-review-${reviewIdCounter}`,
      obligation_id: input.obligationId,
      reviewer_id: input.reviewerId,
      tier: wireTier,
      decision: input.decision,
      rationale: input.rationale,
      decided_at: input.decidedAt ?? "2026-07-13T00:00:00.000Z",
      valid_from: "2026-07-13",
      valid_to: null,
      recorded_at: "2026-07-13T00:00:00.000Z"
    };
    reviews.push(review);
    this.reviews.set(input.obligationId, reviews);

    const requiredCount = input.tier === "B" ? 1 : 2;
    let obligationStatus: ObligationStatus | "still_pending";
    let workflowState: ResumeReviewStepResult["workflowState"];

    if (reviews.length < requiredCount) {
      obligationStatus = input.tier === "B" ? "tier_b_review" : "tier_c_review";
      workflowState = "suspended";
    } else if (input.tier === "B") {
      obligationStatus = input.decision === "approve" ? "committed" : "rejected";
      workflowState = input.decision === "approve" ? "resumed_committed" : "resumed_rejected";
    } else if (reviews[0].decision === reviews[1].decision) {
      obligationStatus = reviews[0].decision === "approve" ? "committed" : "rejected";
      workflowState = reviews[0].decision === "approve" ? "resumed_committed" : "resumed_rejected";
    } else {
      obligationStatus = "escalated";
      workflowState = "resumed_escalated";
    }

    const wire: "B" | "C" | "ESCALATE" = input.tier === "ESCALATE" ? "ESCALATE" : input.tier === "C" ? "C" : "B";
    const reviewGate = await this.getReviewGate(input.obligationId, input.reviewerId, wire);
    return { obligationStatus, workflowState, reviewGate };
  }
}
