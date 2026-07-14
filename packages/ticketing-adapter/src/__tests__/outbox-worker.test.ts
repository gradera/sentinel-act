// FR-13..FR-18 unit tests for processOutboxOnce, and FR-18's
// resetOutboxEntry. All ports are hand-rolled fakes — no real network/DB.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { processOutboxOnce, resetOutboxEntry } from "../outbox-worker.js";
import { AdapterCallError } from "../errors.js";
import type { TicketingContext, TicketingOutboxEntry, TicketMapping } from "../types.js";
import { FakeTicketingOutboxPort, makeFakeAdapter, makeFakeGraph, makeFakeLedger, makeFakeRoleAssigneeMap } from "./fakes.js";

const NOW = "2026-07-14T00:00:00.000Z";

function makeLineageRow(overrides: Record<string, unknown> = {}) {
  return {
    o: {
      obligation_id: "obl-1",
      derived_from_clause_id: "clause-1",
      category: "reporting",
      requirement_text: "req text",
      trigger_event: "trigger",
      deadline_rule: "T+9",
      responsible_role: "Compliance Officer",
      evidence_required: "evidence",
      penalty_ref: null,
      confidence_score: 0.9,
      grounding_score: 0.9,
      status: "committed",
      valid_from: "2026-07-05",
      valid_to: null,
      recorded_at: "2026-07-05T00:00:00.000Z"
    },
    t: {
      task_id: "task-1",
      obligation_id: "obl-1",
      task_name: "Task name",
      owner_role: "Compliance Officer",
      sla_hours: 216,
      system_touchpoint: "portal",
      risk_score: 0.5,
      valid_from: "2026-07-06T00:00:00.000Z",
      valid_to: null,
      recorded_at: "2026-07-06T00:00:00.000Z"
    },
    clauseParaRef: "46",
    circularTitle: "CUSPA Circular",
    circularDateEffective: "2026-07-03",
    circularId: "circ-1",
    ...overrides
  };
}

function makeCtx(overrides: Partial<TicketingContext> = {}): TicketingContext {
  return {
    graph: makeFakeGraph([makeLineageRow()]),
    adapter: makeFakeAdapter(),
    roleAssigneeMap: makeFakeRoleAssigneeMap({
      "Compliance Officer": { externalAssigneeRef: "queue:compliance-ops", displayLabel: "Compliance Officer", isFallback: false }
    }),
    outbox: new FakeTicketingOutboxPort(),
    ledger: makeFakeLedger(),
    referenceDate: NOW,
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

async function seedOutboxEntry(outbox: FakeTicketingOutboxPort, overrides: Partial<Omit<TicketingOutboxEntry, "status" | "attempts" | "next_attempt_at" | "last_error" | "created_at" | "updated_at">> = {}): Promise<string> {
  const id = randomUUID();
  await outbox.insertIfNotExists({
    id,
    event_id: overrides.event_id ?? randomUUID(),
    obligation_id: overrides.obligation_id ?? "obl-1",
    task_id: overrides.task_id ?? "task-1",
    tier: overrides.tier ?? "B"
  });
  return id;
}

describe("processOutboxOnce — happy path (FR-13..FR-15, Acceptance Criterion 1/2)", () => {
  it("creates exactly one ticket, inserts the mapping, marks succeeded, and appends TICKET_CREATED", async () => {
    const outbox = new FakeTicketingOutboxPort();
    const id = await seedOutboxEntry(outbox, { event_id: "evt-1" });
    const ledger = makeFakeLedger();
    const adapter = makeFakeAdapter({
      createTicket: vi.fn(async () => ({ externalTicketId: "ext-1", externalTicketUrl: "https://tickets.example/ext-1", raw: {} }))
    });
    const ctx = makeCtx({ outbox, ledger, adapter });

    const result = await processOutboxOnce(ctx);

    expect(result).toEqual({ processed: 1, succeeded: 1, failedRetryable: 0, failedPermanent: 0 });
    expect(adapter.createTicket).toHaveBeenCalledTimes(1);
    const entry = outbox.getEntry(id)!;
    expect(entry.status).toBe("succeeded");
    const mapping = await outbox.findMapping("task-1");
    expect(mapping).toMatchObject<Partial<TicketMapping>>({ task_id: "task-1", external_ticket_id: "ext-1" });
    expect(ledger.calls).toHaveLength(1);
    expect(ledger.calls[0].event_type).toBe("TICKET_CREATED");
  });
});

describe("processOutboxOnce — FR-4 task_id-level idempotency", () => {
  it("marks succeeded without calling the adapter when a TicketMapping already exists for task_id", async () => {
    const outbox = new FakeTicketingOutboxPort();
    await outbox.insertMapping({ task_id: "task-1", adapter_name: "fake-adapter", external_ticket_id: "ext-existing", external_ticket_url: null, created_at: NOW });
    const id = await seedOutboxEntry(outbox, { event_id: "evt-2" });
    const adapter = makeFakeAdapter();
    const ctx = makeCtx({ outbox, adapter });

    const result = await processOutboxOnce(ctx);

    expect(result.succeeded).toBe(1);
    expect(adapter.createTicket).not.toHaveBeenCalled();
    expect(outbox.getEntry(id)!.status).toBe("succeeded");
  });
});

describe("processOutboxOnce — FR-5 permanent failure when the graph lookup resolves nothing", () => {
  it("marks failed_permanent and appends TICKET_CREATE_FAILED after a single attempt", async () => {
    const outbox = new FakeTicketingOutboxPort();
    const id = await seedOutboxEntry(outbox, { event_id: "evt-3" });
    const ledger = makeFakeLedger();
    const ctx = makeCtx({ outbox, ledger, graph: makeFakeGraph([]) });

    const result = await processOutboxOnce(ctx);

    expect(result).toEqual({ processed: 1, succeeded: 0, failedRetryable: 0, failedPermanent: 1 });
    const entry = outbox.getEntry(id)!;
    expect(entry.status).toBe("failed_permanent");
    expect(entry.attempts).toBe(1);
    expect(ledger.calls[0].event_type).toBe("TICKET_CREATE_FAILED");
  });
});

describe("processOutboxOnce — retryable adapter failure (FR-16, Acceptance Criterion 5)", () => {
  it("sets failed_retryable, increments attempts, and schedules next_attempt_at per the backoff schedule", async () => {
    const outbox = new FakeTicketingOutboxPort();
    const id = await seedOutboxEntry(outbox, { event_id: "evt-4" });
    const adapter = makeFakeAdapter({
      createTicket: vi.fn(async () => {
        throw new AdapterCallError("unreachable", "retryable");
      })
    });
    const ctx = makeCtx({ outbox, adapter });

    const result = await processOutboxOnce(ctx);

    expect(result).toEqual({ processed: 1, succeeded: 0, failedRetryable: 1, failedPermanent: 0 });
    const entry = outbox.getEntry(id)!;
    expect(entry.status).toBe("failed_retryable");
    expect(entry.attempts).toBe(1);
    expect(entry.next_attempt_at).toBe(new Date(new Date(NOW).getTime() + 60_000).toISOString()); // 1st attempt -> 1m
  });

  it("does not call the ledger on a retryable failure", async () => {
    const outbox = new FakeTicketingOutboxPort();
    await seedOutboxEntry(outbox, { event_id: "evt-4b" });
    const ledger = makeFakeLedger();
    const adapter = makeFakeAdapter({
      createTicket: vi.fn(async () => {
        throw new AdapterCallError("unreachable", "retryable");
      })
    });
    const ctx = makeCtx({ outbox, ledger, adapter });
    await processOutboxOnce(ctx);
    expect(ledger.calls).toHaveLength(0);
  });
});

describe("processOutboxOnce — permanent adapter failure (FR-17, Acceptance Criterion 7)", () => {
  it("sets failed_permanent after exactly one attempt, no next_attempt_at scheduling, ledger records the error", async () => {
    const outbox = new FakeTicketingOutboxPort();
    const id = await seedOutboxEntry(outbox, { event_id: "evt-5" });
    const ledger = makeFakeLedger();
    const adapter = makeFakeAdapter({
      createTicket: vi.fn(async () => {
        throw new AdapterCallError("HTTP 422", "permanent");
      })
    });
    const ctx = makeCtx({ outbox, ledger, adapter });

    const result = await processOutboxOnce(ctx);

    expect(result).toEqual({ processed: 1, succeeded: 0, failedRetryable: 0, failedPermanent: 1 });
    const entry = outbox.getEntry(id)!;
    expect(entry.status).toBe("failed_permanent");
    expect(entry.attempts).toBe(1);
    expect(ledger.calls[0].event_type).toBe("TICKET_CREATE_FAILED");
    expect(ledger.calls[0].payload.error).toContain("422");
  });
});

describe("processOutboxOnce — maxAttempts overflow converts a retryable failure into permanent (FR-17)", () => {
  it("treats the (maxAttempts+1)th attempt as permanent, not another retry", async () => {
    const outbox = new FakeTicketingOutboxPort();
    const id = randomUUID();
    // Seed a row already at attempts = maxAttempts (8), claimable now.
    outbox.seed({
      id,
      event_id: "evt-6",
      obligation_id: "obl-1",
      task_id: "task-1",
      tier: "B",
      status: "failed_retryable",
      attempts: 8,
      next_attempt_at: NOW,
      last_error: "prior failure",
      created_at: "2026-07-13T00:00:00.000Z",
      updated_at: "2026-07-13T00:00:00.000Z"
    });
    const adapter = makeFakeAdapter({
      createTicket: vi.fn(async () => {
        throw new AdapterCallError("still down", "retryable");
      })
    });
    const ctx = makeCtx({ outbox, adapter });

    const result = await processOutboxOnce(ctx);

    expect(result.failedPermanent).toBe(1);
    expect(result.failedRetryable).toBe(0);
    const entry = outbox.getEntry(id)!;
    expect(entry.status).toBe("failed_permanent");
    expect(entry.attempts).toBe(9);
  });
});

describe("processOutboxOnce — FR-14 concurrent-claim safety", () => {
  it("a row already claimed by a concurrent worker (status transitioned out from under it) is skipped, not double-processed", async () => {
    const outbox = new FakeTicketingOutboxPort();
    await seedOutboxEntry(outbox, { event_id: "evt-7" });
    // First claim (simulating another worker instance) transitions the row to "processing".
    const firstClaim = await outbox.claimBatch(20, NOW);
    expect(firstClaim).toHaveLength(1);

    const adapter = makeFakeAdapter();
    const ctx = makeCtx({ outbox, adapter });
    const result = await processOutboxOnce(ctx);

    // The second claimBatch call (inside this processOutboxOnce) finds
    // nothing claimable — the row is already "processing".
    expect(result.processed).toBe(0);
    expect(adapter.createTicket).not.toHaveBeenCalled();
  });
});

describe("resetOutboxEntry (FR-18)", () => {
  it("resets a failed_permanent row to pending/attempts:0/last_error:null", async () => {
    const outbox = new FakeTicketingOutboxPort();
    const id = randomUUID();
    outbox.seed({
      id,
      event_id: "evt-8",
      obligation_id: "obl-1",
      task_id: "task-1",
      tier: "B",
      status: "failed_permanent",
      attempts: 3,
      next_attempt_at: NOW,
      last_error: "some error",
      created_at: NOW,
      updated_at: NOW
    });

    await resetOutboxEntry(id, { outbox });

    const entry = outbox.getEntry(id)!;
    expect(entry.status).toBe("pending");
    expect(entry.attempts).toBe(0);
    expect(entry.last_error).toBeNull();
  });

  it("a reset row is picked up by the next processOutboxOnce call", async () => {
    const outbox = new FakeTicketingOutboxPort();
    const id = randomUUID();
    outbox.seed({
      id,
      event_id: "evt-9",
      obligation_id: "obl-1",
      task_id: "task-1",
      tier: "B",
      status: "failed_permanent",
      attempts: 3,
      next_attempt_at: NOW,
      last_error: "some error",
      created_at: NOW,
      updated_at: NOW
    });
    await resetOutboxEntry(id, { outbox });

    const ctx = makeCtx({ outbox });
    const result = await processOutboxOnce(ctx);
    expect(result.succeeded).toBe(1);
  });
});
