// Spec 13 §10 integration tests.
//
// Convention note (mirrors mapping-risk-scoring.graph.integration.test.ts
// and orchestrator.workflow.integration.test.ts's own header comments
// exactly): the spec's Test Plan describes these as running "real
// Postgres via testcontainers ... real Neo4j via testcontainers" — the
// pattern packages/graph-db's own *.integration.test.ts files use.
// apps/orchestrator's actual, already-established convention for its own
// integration tests is different: this app has no testcontainers/
// neo4j-driver devDependency, and no Docker daemon is available in this
// build environment. This file follows the same already-working
// convention: a REAL in-process Node http server stands in for the
// external ticketing system (this is not a compromise — Spec 13 §10
// itself calls for exactly this: "a fake in-process HTTP receiver
// standing in for the external system"), a hand-rolled in-memory
// TicketingOutboxPort faithfully implements the same claim/CAS/unique-
// constraint semantics migrations/001_ticketing_outbox.sql defines, and a
// hand-rolled GraphQueryPort fake returns exactly what the two real
// Cypher queries (BUILD_TICKET_LINEAGE_CYPHER, grc-ticketing.ts's
// RECONCILE_CANDIDATES_CYPHER) would return from a seeded Neo4j instance.
// Every other moving part — the real GenericWebhookAdapter (real HMAC
// signing, real HTTP over loopback), the real handleObligationCommittedEvent/
// processOutboxOnce/reconcileMissedCommits/resetOutboxEntry — is exercised
// for real, not mocked.
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  GenericWebhookAdapter,
  processOutboxOnce,
  resetOutboxEntry
} from "@sentinel-act/ticketing-adapter";
import type {
  AppendLedgerEntryPort,
  GraphQueryPort,
  ObligationCommittedEvent,
  TicketingContext,
  TicketingOutboxEntry,
  TicketingOutboxPort,
  TicketMapping
} from "@sentinel-act/ticketing-adapter";
import { handleObligationCommittedEvent, reconcileMissedCommits } from "../grc-ticketing.js";

const NOW = "2026-07-14T00:00:00.000Z";

// ---------------------------------------------------------------------------
// In-memory TicketingOutboxPort — faithfully implements the unique
// event_id constraint (FR-3), the compare-and-set claim (FR-14), and the
// TicketMapping PK uniqueness (FR-4/FR-15) migrations/
// 001_ticketing_outbox.sql defines.
// ---------------------------------------------------------------------------

class InMemoryTicketingOutboxPort implements TicketingOutboxPort {
  private readonly entries = new Map<string, TicketingOutboxEntry>();
  private readonly mappings = new Map<string, TicketMapping>();
  private readonly eventIds = new Set<string>();
  private clockCounter = 0;

  private tick(): string {
    const ts = new Date(new Date("2000-01-01T00:00:00.000Z").getTime() + this.clockCounter).toISOString();
    this.clockCounter += 1;
    return ts;
  }

  async insertIfNotExists(
    entry: Omit<TicketingOutboxEntry, "status" | "attempts" | "next_attempt_at" | "last_error" | "created_at" | "updated_at">
  ): Promise<{ inserted: boolean }> {
    if (this.eventIds.has(entry.event_id)) {
      return { inserted: false };
    }
    this.eventIds.add(entry.event_id);
    const ts = this.tick();
    this.entries.set(entry.id, { ...entry, status: "pending", attempts: 0, next_attempt_at: ts, last_error: null, created_at: ts, updated_at: ts });
    return { inserted: true };
  }

  async claimBatch(limit: number, now: string): Promise<TicketingOutboxEntry[]> {
    const candidates = [...this.entries.values()]
      .filter((e) => (e.status === "pending" || e.status === "failed_retryable") && e.next_attempt_at <= now)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(0, limit);
    const claimed: TicketingOutboxEntry[] = [];
    for (const c of candidates) {
      const fresh = this.entries.get(c.id);
      if (fresh && (fresh.status === "pending" || fresh.status === "failed_retryable")) {
        fresh.status = "processing";
        claimed.push({ ...fresh });
      }
    }
    return claimed;
  }

  async markSucceeded(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (e) e.status = "succeeded";
  }
  async markRetryable(id: string, nextAttemptAt: string, error: string): Promise<void> {
    const e = this.entries.get(id);
    if (e) {
      e.status = "failed_retryable";
      e.attempts += 1;
      e.next_attempt_at = nextAttemptAt;
      e.last_error = error;
    }
  }
  async markPermanentFailure(id: string, error: string): Promise<void> {
    const e = this.entries.get(id);
    if (e) {
      e.status = "failed_permanent";
      e.attempts += 1;
      e.last_error = error;
    }
  }
  async resetToPending(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (e) {
      e.status = "pending";
      e.attempts = 0;
      e.last_error = null;
      e.next_attempt_at = this.tick();
    }
  }
  async findMapping(task_id: string): Promise<TicketMapping | null> {
    return this.mappings.get(task_id) ?? null;
  }
  async insertMapping(mapping: TicketMapping): Promise<{ inserted: boolean }> {
    if (this.mappings.has(mapping.task_id)) return { inserted: false };
    this.mappings.set(mapping.task_id, mapping);
    return { inserted: true };
  }
  async hasInFlightEntryForTask(task_id: string): Promise<boolean> {
    return [...this.entries.values()].some((e) => e.task_id === task_id && (e.status === "pending" || e.status === "processing" || e.status === "failed_retryable"));
  }

  getEntry(id: string): TicketingOutboxEntry | undefined {
    return this.entries.get(id);
  }
  allEntries(): TicketingOutboxEntry[] {
    return [...this.entries.values()];
  }
}

function makeInMemoryLedger(): AppendLedgerEntryPort & { calls: Array<Parameters<AppendLedgerEntryPort["append"]>[0]> } {
  const calls: Array<Parameters<AppendLedgerEntryPort["append"]>[0]> = [];
  let seq = 0;
  return {
    calls,
    async append(input) {
      seq += 1;
      calls.push(input);
      return { sequence_number: seq };
    }
  };
}

// ---------------------------------------------------------------------------
// Fake graph — dispatches on Cypher query shape, mirroring
// orchestrator.workflow.integration.test.ts's makeStatefulGraph pattern.
// ---------------------------------------------------------------------------

function makeLineageRow(overrides: Record<string, unknown> = {}) {
  return {
    o: {
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
      recorded_at: "2026-07-05T00:00:00.000Z"
    },
    t: {
      task_id: "task-1",
      obligation_id: "obl-1",
      task_name: "File revised broker-dealer risk disclosure with exchange",
      owner_role: "Compliance Officer",
      sla_hours: 216,
      system_touchpoint: "exchange portal",
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

function makeFakeGraph(opts: { lineageRows?: Record<string, unknown>[]; reconcileRows?: Record<string, unknown>[] } = {}): GraphQueryPort {
  const lineageRows = opts.lineageRows ?? [makeLineageRow()];
  const reconcileRows = opts.reconcileRows ?? [];
  return {
    async runCypher<T>(query: string): Promise<T[]> {
      if (query.includes("REVIEWED_BY") && query.includes("count(r)")) {
        return reconcileRows as unknown as T[];
      }
      return lineageRows as unknown as T[];
    }
  };
}

// ---------------------------------------------------------------------------
// Fake in-process HTTP receiver (Spec 13 §10's own literal wording).
// ---------------------------------------------------------------------------

interface ReceivedRequest {
  body: string;
  signature: string | undefined;
}

class FakeWebhookReceiver {
  private server: Server | null = null;
  url = "";
  readonly requests: ReceivedRequest[] = [];
  responder: (requestNumber: number) => { status: number; body: unknown };

  constructor(responder: (requestNumber: number) => { status: number; body: unknown }) {
    this.responder = responder;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        this.requests.push({ body, signature: req.headers["x-sentinel-signature"] as string | undefined });
        const { status, body: respBody } = this.responder(this.requests.length);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(respBody));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    this.url = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server!.close((err) => (err ? reject(err) : resolve())));
  }
}

function makeConfig(): TicketingContext["config"] {
  return {
    defaultAssigneeRef: "queue:unassigned",
    maxAttempts: 8,
    baseBackoffMs: 60_000,
    maxBackoffMs: 21_600_000,
    outboxBatchSize: 20
  };
}

function makeEvent(overrides: Partial<ObligationCommittedEvent> = {}): ObligationCommittedEvent {
  return {
    event_id: randomUUID(),
    obligation_id: "obl-1",
    task_id: "task-1",
    final_status: "committed",
    tier: "B",
    committed_at: NOW,
    ...overrides
  };
}

describe("Spec 13 GRC/Ticketing Integration — handleObligationCommittedEvent -> processOutboxOnce (Acceptance Criteria 1/2/4/5/7)", () => {
  let receiver: FakeWebhookReceiver;

  afterEach(async () => {
    await receiver?.stop();
  });

  it("full happy path: TicketMapping created, exactly one HTTP call, TICKET_CREATED ledger append", async () => {
    receiver = new FakeWebhookReceiver(() => ({ status: 200, body: { externalId: "ext-1", externalUrl: "https://tickets.example/ext-1" } }));
    await receiver.start();

    const outbox = new InMemoryTicketingOutboxPort();
    const ledger = makeInMemoryLedger();
    const ctx: TicketingContext = {
      graph: makeFakeGraph(),
      adapter: new GenericWebhookAdapter({ url: receiver.url, secret: "s3cr3t" }),
      roleAssigneeMap: { resolve: async () => null },
      outbox,
      ledger,
      referenceDate: NOW,
      config: makeConfig()
    };

    const event = makeEvent();
    const { enqueued } = await handleObligationCommittedEvent(event, ctx);
    expect(enqueued).toBe(true);

    const result = await processOutboxOnce(ctx);
    expect(result).toEqual({ processed: 1, succeeded: 1, failedRetryable: 0, failedPermanent: 0 });

    expect(receiver.requests).toHaveLength(1);
    const mapping = await outbox.findMapping("task-1");
    expect(mapping?.external_ticket_id).toBe("ext-1");
    expect(ledger.calls).toHaveLength(1);
    expect(ledger.calls[0].event_type).toBe("TICKET_CREATED");

    const sentBody = JSON.parse(receiver.requests[0].body);
    expect(sentBody.title).toBe("File revised broker-dealer risk disclosure with exchange");
    expect(sentBody.dedupeKey).toBe("task-1");
    expect(receiver.requests[0].signature).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("Acceptance Criterion 1: a Tier A (tier_a_committed) commit produces exactly one ticket with correct field mapping", async () => {
    receiver = new FakeWebhookReceiver(() => ({ status: 200, body: { externalId: "ext-tier-a" } }));
    await receiver.start();
    const outbox = new InMemoryTicketingOutboxPort();
    const ledger = makeInMemoryLedger();
    const ctx: TicketingContext = {
      graph: makeFakeGraph(),
      adapter: new GenericWebhookAdapter({ url: receiver.url, secret: "s3cr3t" }),
      roleAssigneeMap: { resolve: async () => null },
      outbox,
      ledger,
      referenceDate: NOW,
      config: makeConfig()
    };
    const event = makeEvent({ event_id: "evt-tier-a", final_status: "tier_a_committed", tier: "A" });

    await handleObligationCommittedEvent(event, ctx);
    const result = await processOutboxOnce(ctx);

    expect(result).toEqual({ processed: 1, succeeded: 1, failedRetryable: 0, failedPermanent: 0 });
    expect(receiver.requests).toHaveLength(1);
    const sentBody = JSON.parse(receiver.requests[0].body);
    expect(sentBody.title).toBe("File revised broker-dealer risk disclosure with exchange"); // FR-6
    expect(sentBody.dueDate).toBe(new Date(new Date("2026-07-06T00:00:00.000Z").getTime() + 216 * 60 * 60 * 1000).toISOString()); // FR-10
    expect(sentBody.priority).toBe("P2_high"); // FR-11, risk_score 0.5
    expect(sentBody.labels).toEqual(["sentinel-act", "tier:A", "category:reporting"]); // FR-12
    const mapping = await outbox.findMapping("task-1");
    expect(mapping?.external_ticket_id).toBe("ext-tier-a");
    expect(ledger.calls[0].event_type).toBe("TICKET_CREATED");
  });

  it("a redelivered event_id (FR-3) is a no-op — no second outbox row, no second HTTP call", async () => {
    receiver = new FakeWebhookReceiver(() => ({ status: 200, body: { externalId: "ext-1" } }));
    await receiver.start();
    const outbox = new InMemoryTicketingOutboxPort();
    const ctx: TicketingContext = {
      graph: makeFakeGraph(),
      adapter: new GenericWebhookAdapter({ url: receiver.url, secret: "s3cr3t" }),
      roleAssigneeMap: { resolve: async () => null },
      outbox,
      ledger: makeInMemoryLedger(),
      referenceDate: NOW,
      config: makeConfig()
    };
    const event = makeEvent({ event_id: "evt-fixed" });

    const first = await handleObligationCommittedEvent(event, ctx);
    expect(first.enqueued).toBe(true);
    const second = await handleObligationCommittedEvent(event, ctx);
    expect(second.enqueued).toBe(false);

    await processOutboxOnce(ctx);
    expect(receiver.requests).toHaveLength(1);
    expect(outbox.allEntries()).toHaveLength(1);
  });

  it("two concurrent processOutboxOnce calls racing the same claimable row -> exactly one HTTP call (FR-14)", async () => {
    receiver = new FakeWebhookReceiver(() => ({ status: 200, body: { externalId: "ext-1" } }));
    await receiver.start();
    const outbox = new InMemoryTicketingOutboxPort();
    const ctx: TicketingContext = {
      graph: makeFakeGraph(),
      adapter: new GenericWebhookAdapter({ url: receiver.url, secret: "s3cr3t" }),
      roleAssigneeMap: { resolve: async () => null },
      outbox,
      ledger: makeInMemoryLedger(),
      referenceDate: NOW,
      config: makeConfig()
    };
    await handleObligationCommittedEvent(makeEvent(), ctx);

    const [r1, r2] = await Promise.all([processOutboxOnce(ctx), processOutboxOnce(ctx)]);
    const totalProcessed = r1.processed + r2.processed;
    expect(totalProcessed).toBe(1);
    expect(receiver.requests).toHaveLength(1);
  });

  it("permanent-failure path (HTTP 422) — failed_permanent after exactly one attempt, TICKET_CREATE_FAILED ledger append (Acceptance Criterion 7)", async () => {
    receiver = new FakeWebhookReceiver(() => ({ status: 422, body: { error: "validation failed" } }));
    await receiver.start();
    const outbox = new InMemoryTicketingOutboxPort();
    const ledger = makeInMemoryLedger();
    const ctx: TicketingContext = {
      graph: makeFakeGraph(),
      adapter: new GenericWebhookAdapter({ url: receiver.url, secret: "s3cr3t" }),
      roleAssigneeMap: { resolve: async () => null },
      outbox,
      ledger,
      referenceDate: NOW,
      config: makeConfig()
    };
    await handleObligationCommittedEvent(makeEvent({ event_id: "evt-422" }), ctx);

    const result = await processOutboxOnce(ctx);
    expect(result.failedPermanent).toBe(1);
    expect(receiver.requests).toHaveLength(1);
    const entry = outbox.allEntries()[0];
    expect(entry.status).toBe("failed_permanent");
    expect(entry.attempts).toBe(1);
    expect(ledger.calls[0].event_type).toBe("TICKET_CREATE_FAILED");
  });

  it("retryable-failure-then-recovery path — failed_retryable, failed_retryable, then succeeded, with backoff-respecting next_attempt_at (Acceptance Criterion 5)", async () => {
    receiver = new FakeWebhookReceiver((n) => (n <= 2 ? { status: 503, body: { error: "down" } } : { status: 200, body: { externalId: "ext-1" } }));
    await receiver.start();
    const outbox = new InMemoryTicketingOutboxPort();
    const config = makeConfig();
    let referenceDate = NOW;
    const ctx = (): TicketingContext => ({
      graph: makeFakeGraph(),
      adapter: new GenericWebhookAdapter({ url: receiver.url, secret: "s3cr3t" }),
      roleAssigneeMap: { resolve: async () => null },
      outbox,
      ledger: makeInMemoryLedger(),
      referenceDate,
      config
    });
    await handleObligationCommittedEvent(makeEvent({ event_id: "evt-retry" }), ctx());

    const attempt1 = await processOutboxOnce(ctx());
    expect(attempt1.failedRetryable).toBe(1);
    let entry = outbox.allEntries()[0];
    expect(entry.status).toBe("failed_retryable");
    expect(entry.attempts).toBe(1);
    const firstBackoffMs = new Date(entry.next_attempt_at).getTime() - new Date(referenceDate).getTime();
    expect(firstBackoffMs).toBe(60_000); // 1st attempt -> 1 minute

    // Advance the clock past next_attempt_at before the 2nd poll.
    referenceDate = entry.next_attempt_at;
    const attempt2 = await processOutboxOnce(ctx());
    expect(attempt2.failedRetryable).toBe(1);
    entry = outbox.allEntries()[0];
    expect(entry.status).toBe("failed_retryable");
    expect(entry.attempts).toBe(2);
    const secondBackoffMs = new Date(entry.next_attempt_at).getTime() - new Date(referenceDate).getTime();
    expect(secondBackoffMs).toBe(120_000); // 2nd attempt -> 2 minutes

    referenceDate = entry.next_attempt_at;
    const attempt3 = await processOutboxOnce(ctx());
    expect(attempt3.succeeded).toBe(1);
    entry = outbox.allEntries()[0];
    expect(entry.status).toBe("succeeded");
    expect(receiver.requests).toHaveLength(3);
  });

  it("resetOutboxEntry resumes a failed_permanent row on the next processOutboxOnce call", async () => {
    receiver = new FakeWebhookReceiver((n) => (n === 1 ? { status: 400, body: { error: "bad" } } : { status: 200, body: { externalId: "ext-recovered" } }));
    await receiver.start();
    const outbox = new InMemoryTicketingOutboxPort();
    const ctx: TicketingContext = {
      graph: makeFakeGraph(),
      adapter: new GenericWebhookAdapter({ url: receiver.url, secret: "s3cr3t" }),
      roleAssigneeMap: { resolve: async () => null },
      outbox,
      ledger: makeInMemoryLedger(),
      referenceDate: NOW,
      config: makeConfig()
    };
    await handleObligationCommittedEvent(makeEvent({ event_id: "evt-resume" }), ctx);

    const first = await processOutboxOnce(ctx);
    expect(first.failedPermanent).toBe(1);
    const id = outbox.allEntries()[0].id;

    await resetOutboxEntry(id, ctx);
    expect(outbox.getEntry(id)!.status).toBe("pending");

    const second = await processOutboxOnce(ctx);
    expect(second.succeeded).toBe(1);
    expect(receiver.requests).toHaveLength(2);
  });
});

describe("reconcileMissedCommits (FR-19..FR-21, Acceptance Criterion 6)", () => {
  let receiver: FakeWebhookReceiver;
  afterEach(async () => {
    await receiver?.stop();
  });

  it("detects a committed task with no TicketMapping and no in-flight outbox row, backfills, and the normal outbox path creates a ticket for it", async () => {
    receiver = new FakeWebhookReceiver(() => ({ status: 200, body: { externalId: "ext-backfilled" } }));
    await receiver.start();
    const outbox = new InMemoryTicketingOutboxPort();
    const ledger = makeInMemoryLedger();
    const ctx: TicketingContext = {
      graph: makeFakeGraph({
        reconcileRows: [{ obligationId: "obl-1", obligationStatus: "tier_a_committed", obligationRecordedAt: "2026-07-06T00:00:00.000Z", taskId: "task-1", reviewCount: 0 }]
      }),
      adapter: new GenericWebhookAdapter({ url: receiver.url, secret: "s3cr3t" }),
      roleAssigneeMap: { resolve: async () => null },
      outbox,
      ledger,
      referenceDate: NOW,
      config: makeConfig()
    };

    const sweep = await reconcileMissedCommits(ctx);
    expect(sweep.backfilled).toBe(1);
    expect(outbox.allEntries()).toHaveLength(1);

    const result = await processOutboxOnce(ctx);
    expect(result.succeeded).toBe(1);
    expect(receiver.requests).toHaveLength(1);
    const mapping = await outbox.findMapping("task-1");
    expect(mapping?.external_ticket_id).toBe("ext-backfilled");
  });

  it("does not backfill a task that already has a TicketMapping", async () => {
    receiver = new FakeWebhookReceiver(() => ({ status: 200, body: { externalId: "unused" } }));
    await receiver.start();
    const outbox = new InMemoryTicketingOutboxPort();
    await outbox.insertMapping({ task_id: "task-1", adapter_name: "generic-webhook", external_ticket_id: "ext-already", external_ticket_url: null, created_at: NOW });
    const ctx: TicketingContext = {
      graph: makeFakeGraph({
        reconcileRows: [{ obligationId: "obl-1", obligationStatus: "tier_a_committed", obligationRecordedAt: NOW, taskId: "task-1", reviewCount: 0 }]
      }),
      adapter: new GenericWebhookAdapter({ url: receiver.url, secret: "s3cr3t" }),
      roleAssigneeMap: { resolve: async () => null },
      outbox,
      ledger: makeInMemoryLedger(),
      referenceDate: NOW,
      config: makeConfig()
    };

    const sweep = await reconcileMissedCommits(ctx);
    expect(sweep.backfilled).toBe(0);
    expect(outbox.allEntries()).toHaveLength(0);
  });

  it("does not backfill a task with an in-flight outbox row already", async () => {
    receiver = new FakeWebhookReceiver(() => ({ status: 200, body: { externalId: "unused" } }));
    await receiver.start();
    const outbox = new InMemoryTicketingOutboxPort();
    const ctx: TicketingContext = {
      graph: makeFakeGraph({
        reconcileRows: [{ obligationId: "obl-1", obligationStatus: "tier_a_committed", obligationRecordedAt: NOW, taskId: "task-1", reviewCount: 0 }]
      }),
      adapter: new GenericWebhookAdapter({ url: receiver.url, secret: "s3cr3t" }),
      roleAssigneeMap: { resolve: async () => null },
      outbox,
      ledger: makeInMemoryLedger(),
      referenceDate: NOW,
      config: makeConfig()
    };
    // A live trigger already has an in-flight (pending) row for this task.
    await handleObligationCommittedEvent(makeEvent({ event_id: "evt-live", task_id: "task-1" }), ctx);

    const sweep = await reconcileMissedCommits(ctx);
    expect(sweep.backfilled).toBe(0);
    expect(outbox.allEntries()).toHaveLength(1); // still just the one live-trigger row
  });
});
