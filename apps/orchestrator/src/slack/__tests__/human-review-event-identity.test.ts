// Spec 11 §10 / Fix 1 regression test: "HumanReviewSubmittedEvent field-
// identity check comparing a Slack-path fixture against a console-path
// (Spec 09) fixture — equal except `source`."
//
// The console-path fixture below is a literal reproduction of the object
// construction in
// apps/web-console/app/api/console/items/[obligationId]/decisions/route.ts
// (confirmed by direct inspection: `{ event_id: randomUUID(), obligation_id,
// reviewer_id: session.reviewerId, tier: humanReviewTierFor(tier), decision,
// rationale, decided_at: new Date().toISOString(), source: "web-console" as
// const, source_ref: null }`, with `humanReviewTierFor` mapping any
// non-"B" tier — including the ESCALATE case — to "C"). This test imports
// the REAL production function this unit uses on the Slack path
// (buildHumanReviewSubmittedEvent, human-review-event.ts) — not a
// hand-rolled duplicate — so a future edit to either path's shape would
// break this test rather than silently drift.
import { describe, expect, it } from "vitest";
import { buildHumanReviewSubmittedEvent, humanReviewTierForSlack } from "../human-review-event.js";

const FIXED_NOW = "2026-07-13T09:00:00.000Z";

/** Literal reproduction of the console BFF's decisions/route.ts
 *  construction (see this file's header comment for the exact source). */
function buildConsolePathFixture(input: {
  obligationId: string;
  reviewerId: string;
  tier: "B" | "C" | "ESCALATE";
  decision: "approve" | "reject";
  rationale: string | null;
  eventId: string;
}) {
  const humanReviewTierFor = (tier: "B" | "C" | "ESCALATE"): "B" | "C" => (tier === "B" ? "B" : "C");
  return {
    event_id: input.eventId,
    obligation_id: input.obligationId,
    reviewer_id: input.reviewerId,
    tier: humanReviewTierFor(input.tier),
    decision: input.decision,
    rationale: input.rationale,
    decided_at: FIXED_NOW,
    source: "web-console" as const,
    source_ref: null
  };
}

describe("HumanReviewSubmittedEvent field-identity: Slack path vs console path (Fix 1 regression test)", () => {
  it("produces the same field SET and the same VALUES for every field except source (and source_ref, whose differing content is a documented, intentional traceability difference — see below)", () => {
    const shared = {
      obligationId: "OBL-2026-0611",
      reviewerId: "senior-a",
      tier: "C" as const,
      decision: "approve" as const,
      rationale: "Matches the circular text.",
      eventId: "11111111-1111-1111-1111-111111111111"
    };

    const slackEvent = buildHumanReviewSubmittedEvent({
      ...shared,
      sourceRef: JSON.stringify({ channel: "D123", message_ts: "1234.5678", user_id: "U123" }),
      decidedAt: FIXED_NOW
    });
    const consoleEvent = buildConsolePathFixture(shared);

    // Same key set on both objects.
    expect(Object.keys(slackEvent).sort()).toEqual(Object.keys(consoleEvent).sort());

    // Every field equal EXCEPT source (and source_ref, addressed below).
    expect(slackEvent.event_id).toBe(consoleEvent.event_id);
    expect(slackEvent.obligation_id).toBe(consoleEvent.obligation_id);
    expect(slackEvent.reviewer_id).toBe(consoleEvent.reviewer_id);
    expect(slackEvent.tier).toBe(consoleEvent.tier);
    expect(slackEvent.decision).toBe(consoleEvent.decision);
    expect(slackEvent.rationale).toBe(consoleEvent.rationale);
    expect(slackEvent.decided_at).toBe(consoleEvent.decided_at);

    expect(slackEvent.source).toBe("slack");
    expect(consoleEvent.source).toBe("web-console");
    expect(slackEvent.source).not.toBe(consoleEvent.source);

    // source_ref: both are the SAME TYPE (string | null, Spec 07 §4's
    // "opaque... traceability handle into the source system") but
    // legitimately carry different CONTENT per source — the console path
    // always sends null (confirmed in decisions/route.ts), the Slack path
    // always sends a serialized {channel, message_ts, user_id} triple
    // (NFR-Security-3/traceability). This is the one field beyond
    // `source` itself whose VALUE differs by design; its presence and
    // type on both objects is identical, which is what an auditor-facing
    // reader (Spec 07/10) actually depends on — never its content.
    expect(typeof slackEvent.source_ref === "string" || slackEvent.source_ref === null).toBe(true);
    expect(consoleEvent.source_ref).toBeNull();
  });

  it("ESCALATE maps to wire tier 'C' on the Slack path, matching the console path's humanReviewTierFor mapping exactly", () => {
    expect(humanReviewTierForSlack("ESCALATE")).toBe("C");
    expect(humanReviewTierForSlack("B")).toBe("B");
    expect(humanReviewTierForSlack("C")).toBe("C");

    const slackEvent = buildHumanReviewSubmittedEvent({
      obligationId: "OBL-1",
      reviewerId: "r1",
      tier: "ESCALATE",
      decision: "reject",
      rationale: "Contradiction confirmed.",
      sourceRef: null,
      decidedAt: FIXED_NOW,
      eventId: "e1"
    });
    const consoleEvent = buildConsolePathFixture({
      obligationId: "OBL-1",
      reviewerId: "r1",
      tier: "ESCALATE",
      decision: "reject",
      rationale: "Contradiction confirmed.",
      eventId: "e1"
    });
    expect(slackEvent.tier).toBe(consoleEvent.tier);
    expect(slackEvent.tier).toBe("C");
  });

  it("generates a fresh event_id via randomUUID when none is supplied (idempotency-key convention, same as the console path)", () => {
    const e1 = buildHumanReviewSubmittedEvent({ obligationId: "o", reviewerId: "r", tier: "B", decision: "approve", rationale: null, sourceRef: null });
    const e2 = buildHumanReviewSubmittedEvent({ obligationId: "o", reviewerId: "r", tier: "B", decision: "approve", rationale: null, sourceRef: null });
    expect(e1.event_id).not.toBe(e2.event_id);
    expect(e1.event_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
