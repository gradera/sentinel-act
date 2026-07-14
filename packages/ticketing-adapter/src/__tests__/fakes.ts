// Shared hand-rolled fakes for this package's unit tests — no real
// network/DB, mirroring apps/orchestrator's own established convention
// (e.g. monitoring-and-audit.agent.test.ts's makeFakeGraph/makeFakeLedger)
// for hermetic, fast, deterministic test doubles.
import { vi } from "vitest";
import type {
  AppendLedgerEntryPort,
  GraphQueryPort,
  RoleAssigneeMapPort,
  TicketAssignee,
  TicketingAdapter,
  TicketingOutboxEntry,
  TicketingOutboxPort,
  TicketMapping
} from "../types.js";

// A deterministic, monotonically-increasing, always-in-the-past fake
// clock — NOT `new Date().toISOString()` (the real wall clock). This
// fake's whole point is that a freshly-inserted/-reset row is
// immediately claimable by `claimBatch(limit, now)` regardless of
// whatever fixed `NOW` constant a test's `ctx.referenceDate` uses
// (typically an arbitrary in-story date like "2026-07-14..."), exactly
// mirroring real Postgres's `next_attempt_at TIMESTAMPTZ NOT NULL
// DEFAULT now()` column default's intent ("claimable right away") without
// coupling this fake to the actual system clock, which is at least as
// late as this repo's story date in this sandbox and would otherwise make
// `next_attempt_at <= now` spuriously false.
const FAKE_CLOCK_BASE_MS = new Date("2000-01-01T00:00:00.000Z").getTime();
let fakeClockCounter = 0;
function nextFakeClockTick(): string {
  const ts = new Date(FAKE_CLOCK_BASE_MS + fakeClockCounter).toISOString();
  fakeClockCounter += 1;
  return ts;
}

export class FakeTicketingOutboxPort implements TicketingOutboxPort {
  private readonly entries = new Map<string, TicketingOutboxEntry>();
  private readonly mappings = new Map<string, TicketMapping>();
  private readonly eventIds = new Set<string>();

  async insertIfNotExists(
    entry: Omit<TicketingOutboxEntry, "status" | "attempts" | "next_attempt_at" | "last_error" | "created_at" | "updated_at">
  ): Promise<{ inserted: boolean }> {
    if (this.eventIds.has(entry.event_id)) {
      return { inserted: false };
    }
    this.eventIds.add(entry.event_id);
    const ts = nextFakeClockTick();
    this.entries.set(entry.id, {
      ...entry,
      status: "pending",
      attempts: 0,
      next_attempt_at: ts,
      last_error: null,
      created_at: ts,
      updated_at: ts
    });
    return { inserted: true };
  }

  async claimBatch(limit: number, now: string): Promise<TicketingOutboxEntry[]> {
    const candidates = [...this.entries.values()]
      .filter((e) => (e.status === "pending" || e.status === "failed_retryable") && e.next_attempt_at <= now)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(0, limit);

    const claimed: TicketingOutboxEntry[] = [];
    for (const candidate of candidates) {
      const fresh = this.entries.get(candidate.id);
      if (fresh && (fresh.status === "pending" || fresh.status === "failed_retryable")) {
        fresh.status = "processing";
        claimed.push({ ...fresh });
      }
    }
    return claimed;
  }

  async markSucceeded(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (e) {
      e.status = "succeeded";
    }
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
      e.next_attempt_at = nextFakeClockTick();
    }
  }

  async findMapping(task_id: string): Promise<TicketMapping | null> {
    return this.mappings.get(task_id) ?? null;
  }

  async insertMapping(mapping: TicketMapping): Promise<{ inserted: boolean }> {
    if (this.mappings.has(mapping.task_id)) {
      return { inserted: false };
    }
    this.mappings.set(mapping.task_id, mapping);
    return { inserted: true };
  }

  async hasInFlightEntryForTask(task_id: string): Promise<boolean> {
    return [...this.entries.values()].some(
      (e) => e.task_id === task_id && (e.status === "pending" || e.status === "processing" || e.status === "failed_retryable")
    );
  }

  // ---- test-only inspection helpers ----
  getEntry(id: string): TicketingOutboxEntry | undefined {
    return this.entries.get(id);
  }
  allEntries(): TicketingOutboxEntry[] {
    return [...this.entries.values()];
  }
  seed(entry: TicketingOutboxEntry): void {
    this.entries.set(entry.id, entry);
    this.eventIds.add(entry.event_id);
  }
}

export function makeFakeGraph(rows: Record<string, unknown>[] = []): GraphQueryPort {
  return {
    async runCypher<T = Record<string, unknown>>(): Promise<T[]> {
      return rows as unknown as T[];
    }
  };
}

export function makeFakeLedger(): AppendLedgerEntryPort & { calls: Array<Parameters<AppendLedgerEntryPort["append"]>[0]> } {
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

export function makeFakeRoleAssigneeMap(entries: Record<string, TicketAssignee> = {}): RoleAssigneeMapPort {
  return {
    async resolve(owner_role: string) {
      return entries[owner_role] ?? null;
    }
  };
}

export function makeFakeAdapter(impl?: Partial<TicketingAdapter>): TicketingAdapter {
  return {
    adapterName: "fake-adapter",
    createTicket: vi.fn(async () => ({ externalTicketId: "ext-1", externalTicketUrl: null, raw: {} })),
    updateTicket: vi.fn(async () => ({ updated: true, raw: {} })),
    ...impl
  };
}
