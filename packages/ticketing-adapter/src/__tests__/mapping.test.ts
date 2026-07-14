// Spec 13 §10 unit tests: buildCreateTicketRequest field-mapping
// correctness, computeTicketDueDate (FR-10 drift guard against
// DEADLINE_FIXTURE), computeTicketPriority (FR-11 boundary table),
// composeLabels (FR-12), and the FR-8 assignee-fallback path.
import { describe, expect, it } from "vitest";
import type { Obligation, ProcessTask } from "@sentinel-act/graph-schema";
import { DEADLINE_FIXTURE } from "../__fixtures__/deadline.fixture.js";
import {
  buildCreateTicketRequest,
  composeDescription,
  composeLabels,
  computeTicketDueDate,
  computeTicketPriority,
  resolveAssignee
} from "../mapping.js";
import type { ObligationCommittedEvent, TicketingContext, TicketLineage } from "../types.js";
import { makeFakeRoleAssigneeMap } from "./fakes.js";

function makeObligation(overrides: Partial<Obligation> = {}): Obligation {
  return {
    obligation_id: "obl-1",
    derived_from_clause_id: "clause-1",
    category: "reporting",
    requirement_text: "File revised broker-dealer risk disclosure with exchange",
    trigger_event: "circular effective",
    deadline_rule: "T+9 calendar days",
    responsible_role: "Compliance Officer",
    evidence_required: "signed disclosure filing receipt",
    penalty_ref: null,
    confidence_score: 0.9,
    grounding_score: 0.9,
    status: "committed",
    valid_from: "2026-07-05",
    valid_to: null,
    recorded_at: "2026-07-05T00:00:00.000Z",
    ...overrides
  };
}

function makeTask(overrides: Partial<ProcessTask> = {}): ProcessTask {
  return {
    task_id: "task-1",
    obligation_id: "obl-1",
    task_name: "File revised broker-dealer risk disclosure with exchange",
    owner_role: "Compliance Officer",
    sla_hours: 216,
    system_touchpoint: "exchange portal",
    risk_score: 0.5,
    valid_from: "2026-07-06T00:00:00.000Z",
    valid_to: null,
    recorded_at: "2026-07-06T00:00:00.000Z",
    ...overrides
  };
}

function makeLineage(overrides: Partial<TicketLineage> = {}): TicketLineage {
  return {
    clauseParaRef: "46",
    circularTitle: "CUSPA Circular",
    circularDateEffective: "2026-07-03",
    circularId: "circ-1",
    ...overrides
  };
}

function makeEvent(overrides: Partial<ObligationCommittedEvent> = {}): ObligationCommittedEvent {
  return {
    event_id: "evt-1",
    obligation_id: "obl-1",
    task_id: "task-1",
    final_status: "committed",
    tier: "B",
    committed_at: "2026-07-06T00:00:00.000Z",
    ...overrides
  };
}

function makeCtx(overrides: Partial<Pick<TicketingContext, "roleAssigneeMap" | "config">> = {}): Pick<TicketingContext, "roleAssigneeMap" | "config"> {
  return {
    roleAssigneeMap: makeFakeRoleAssigneeMap(),
    config: {
      defaultAssigneeRef: "queue:unassigned",
      maxAttempts: 8,
      baseBackoffMs: 60_000,
      maxBackoffMs: 21_600_000,
      outboxBatchSize: 20
    },
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// computeTicketDueDate (FR-10) — drift guard against the shared fixture.
// ---------------------------------------------------------------------------

describe("computeTicketDueDate (FR-10)", () => {
  it.each(DEADLINE_FIXTURE)("$name: valid_from=$valid_from sla_hours=$sla_hours -> $expected", ({ valid_from, sla_hours, expected }) => {
    expect(computeTicketDueDate({ valid_from, sla_hours })).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// computeTicketPriority (FR-11) — exact boundary table.
// ---------------------------------------------------------------------------

describe("computeTicketPriority (FR-11)", () => {
  it.each([
    [0.39, "P3_normal"],
    [0.4, "P2_high"],
    [0.74, "P2_high"],
    [0.75, "P1_urgent"],
    [1.0, "P1_urgent"]
  ] as const)("risk_score=%s -> %s", (score, expected) => {
    expect(computeTicketPriority(score)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// composeDescription (FR-7) — order, penalty_ref omission, partial lineage.
// ---------------------------------------------------------------------------

describe("composeDescription (FR-7)", () => {
  it("composes requirement, deadline rule, evidence, penalty, and lineage in order", () => {
    const description = composeDescription(
      makeObligation({ penalty_ref: "Reg 1(2)" }),
      makeLineage()
    );
    const lines = description.split("\n\n");
    expect(lines[0]).toContain("**Requirement:**");
    expect(lines[1]).toContain("**Deadline rule:**");
    expect(lines[2]).toContain("**Evidence required:**");
    expect(lines[3]).toContain("**Penalty:** Reg 1(2)");
    expect(lines[4]).toBe("**Source:** CUSPA Circular, effective 2026-07-03, para 46");
  });

  it("omits the Penalty line entirely when penalty_ref is null", () => {
    const description = composeDescription(makeObligation({ penalty_ref: null }), makeLineage());
    expect(description).not.toContain("**Penalty:**");
    const lines = description.split("\n\n");
    expect(lines).toHaveLength(4); // requirement, deadline, evidence, lineage — no penalty line
  });

  it("states only the fields that resolved when Clause/Circular are null, never a placeholder like 'undefined'", () => {
    const description = composeDescription(
      makeObligation({ penalty_ref: null }),
      makeLineage({ clauseParaRef: null, circularTitle: null, circularDateEffective: null, circularId: null })
    );
    expect(description).toContain("**Source:** lineage unavailable");
    expect(description).not.toContain("undefined");
  });

  it("includes only the clauseParaRef when title/date are null", () => {
    const description = composeDescription(
      makeObligation({ penalty_ref: null }),
      makeLineage({ clauseParaRef: "46", circularTitle: null, circularDateEffective: null })
    );
    expect(description).toContain("**Source:** para 46");
    expect(description).not.toContain("undefined");
  });
});

// ---------------------------------------------------------------------------
// composeLabels (FR-12)
// ---------------------------------------------------------------------------

describe("composeLabels (FR-12)", () => {
  it("always includes sentinel-act, tier:<tier>, category:<category>", () => {
    expect(composeLabels({ tier: "B" }, "reporting")).toEqual(["sentinel-act", "tier:B", "category:reporting"]);
    expect(composeLabels({ tier: "ESCALATE" }, "client_asset_protection")).toEqual([
      "sentinel-act",
      "tier:ESCALATE",
      "category:client_asset_protection"
    ]);
  });
});

// ---------------------------------------------------------------------------
// resolveAssignee / buildCreateTicketRequest FR-8 fallback path.
// ---------------------------------------------------------------------------

describe("resolveAssignee (FR-8)", () => {
  it("returns the mapped assignee when RoleAssigneeMapPort has an entry", async () => {
    const ctx = makeCtx({
      roleAssigneeMap: makeFakeRoleAssigneeMap({
        "Compliance Officer": { externalAssigneeRef: "queue:compliance-ops", displayLabel: "Compliance Officer", isFallback: false }
      })
    });
    const assignee = await resolveAssignee("Compliance Officer", ctx);
    expect(assignee).toEqual({ externalAssigneeRef: "queue:compliance-ops", displayLabel: "Compliance Officer", isFallback: false });
  });

  it("falls back to the configured default queue with isFallback: true when no mapping exists", async () => {
    const ctx = makeCtx({ roleAssigneeMap: makeFakeRoleAssigneeMap({}) });
    const assignee = await resolveAssignee("Unknown Role", ctx);
    expect(assignee).toEqual({ externalAssigneeRef: "queue:unassigned", displayLabel: "Unknown Role", isFallback: true });
  });
});

// ---------------------------------------------------------------------------
// buildCreateTicketRequest (FR-5..FR-12 composed)
// ---------------------------------------------------------------------------

describe("buildCreateTicketRequest", () => {
  it("populates every field, title verbatim, dedupeKey === task_id", async () => {
    const ctx = makeCtx({
      roleAssigneeMap: makeFakeRoleAssigneeMap({
        "Compliance Officer": { externalAssigneeRef: "queue:compliance-ops", displayLabel: "Compliance Officer", isFallback: false }
      })
    });
    const request = await buildCreateTicketRequest(makeObligation(), makeTask(), makeLineage(), makeEvent({ tier: "B" }), ctx);

    expect(request.dedupeKey).toBe("task-1");
    expect(request.title).toBe("File revised broker-dealer risk disclosure with exchange");
    expect(request.assignee.isFallback).toBe(false);
    expect(request.dueDate).toBe(computeTicketDueDate(makeTask()));
    expect(request.priority).toBe("P2_high"); // risk_score 0.5
    expect(request.labels).toEqual(["sentinel-act", "tier:B", "category:reporting"]);
    expect(request.sourceRefs).toEqual({
      obligation_id: "obl-1",
      task_id: "task-1",
      circular_id: "circ-1",
      clause_para_ref: "46"
    });
    // No field left undefined.
    for (const [key, value] of Object.entries(request)) {
      expect(value, `field "${key}" must not be undefined`).not.toBeUndefined();
    }
  });
});
