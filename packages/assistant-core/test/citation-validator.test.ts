// citation-validator.test.ts (Spec 12 §10): an id in citedNodeIds not
// present in AssistantGraphContext is dropped, not rendered; order/dedup
// behavior is correct; every accepted citation gets the correct href per
// §4.6's table for each of the five CitationTypes.
import { describe, expect, it } from "vitest";
import type { AssistantGraphContext } from "@sentinel-act/graph-db";
import { buildValidatedCitations } from "../src/citation-validator.js";

function fullContext(): AssistantGraphContext {
  return {
    circulars: [{ circular_id: "cir-1", title: "CUSPA Master Circular", date_issued: "2026-01-01", date_effective: "2026-02-01" }],
    clauses: [{ clause_id: "cl-46", para_ref: "46", text: "Client securities must not be pledged.", circular_id: "cir-1" }],
    obligations: [
      {
        obligation_id: "ob-1",
        category: "custody",
        requirement_text:
          "Custodians must not pledge, hypothecate, or otherwise encumber client securities without written client consent.",
        trigger_event: "receipt of client securities",
        deadline_rule: "immediate",
        responsible_role: "custodian",
        penalty_ref: null,
        status: "committed",
        confidence_score: 0.95,
        grounding_score: 0.9,
        derived_from_clause_id: "cl-46"
      }
    ],
    processTasks: [
      { task_id: "task-1", task_name: "Reconcile custody ledger", owner_role: "custodian-ops", sla_hours: 24, risk_score: 0.4, obligation_id: "ob-1" }
    ],
    humanReviews: [
      {
        review_id: "rev-1",
        reviewer_id: "reviewer-1",
        tier: "B",
        decision: "approve",
        rationale: "Consistent with existing custody obligations.",
        decided_at: "2026-02-05T00:00:00Z",
        obligation_id: "ob-1"
      }
    ]
  };
}

describe("buildValidatedCitations", () => {
  it("builds the correct href for each of the five citation types (§4.6)", () => {
    const context = fullContext();
    const citations = buildValidatedCitations(["cir-1", "cl-46", "ob-1", "task-1", "rev-1"], context);

    expect(citations.find((c) => c.id === "cir-1")).toMatchObject({ type: "Circular", href: "/audit?circularId=cir-1" });
    expect(citations.find((c) => c.id === "cl-46")).toMatchObject({ type: "Clause", href: "/audit?circularId=cir-1" });
    expect(citations.find((c) => c.id === "ob-1")).toMatchObject({ type: "Obligation", href: "/audit?obligationId=ob-1" });
    expect(citations.find((c) => c.id === "task-1")).toMatchObject({ type: "ProcessTask", href: "/audit?obligationId=ob-1" });
    expect(citations.find((c) => c.id === "rev-1")).toMatchObject({ type: "HumanReview", href: "/audit?obligationId=ob-1" });
  });

  it("Clause label carries the paragraph reference since Clause has no standalone route", () => {
    const citations = buildValidatedCitations(["cl-46"], fullContext());
    expect(citations[0].label).toBe("Clause ¶46");
  });

  it("preserves the order the model cited ids in", () => {
    const citations = buildValidatedCitations(["rev-1", "cir-1", "ob-1"], fullContext());
    expect(citations.map((c) => c.id)).toEqual(["rev-1", "cir-1", "ob-1"]);
  });

  it("dedups a repeated id, keeping only its first occurrence's position", () => {
    const citations = buildValidatedCitations(["ob-1", "cir-1", "ob-1"], fullContext());
    expect(citations.map((c) => c.id)).toEqual(["ob-1", "cir-1"]);
  });

  it("drops an id not present in the context (FR-18) rather than rendering a broken/fake link", () => {
    const citations = buildValidatedCitations(["ob-1", "not-a-real-id"], fullContext());
    expect(citations.map((c) => c.id)).toEqual(["ob-1"]);
  });

  it("returns an empty citation list for an empty citedNodeIds array", () => {
    const citations = buildValidatedCitations([], fullContext());
    expect(citations).toEqual([]);
  });

  it("truncates a long Obligation requirement_text in its label", () => {
    const citations = buildValidatedCitations(["ob-1"], fullContext());
    expect(citations[0].label.length).toBeLessThan(80);
    expect(citations[0].label.startsWith("Obligation (")).toBe(true);
  });
});
