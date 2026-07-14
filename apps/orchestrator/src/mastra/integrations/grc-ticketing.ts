// Spec 13 — GRC/Ticketing Integration. Orchestrator-side wiring: the
// trigger intake (handleObligationCommittedEvent, FR-1..FR-4, deliberately
// placed here per Spec 13 §5.1 rather than in packages/ticketing-adapter),
// the reconciliation sweep (reconcileMissedCommits, FR-19..FR-21 — reads
// Neo4j via createGraphQueryPortFromDriver, so it must live in this app,
// not the package, which cannot depend on the neo4j-driver-backed
// adapter), the TicketingTriggerPort the Spec 08 finalizeCommit hook
// calls, real TicketingContext construction from env, and the background
// polling loops (outbox worker + reconciliation sweep).
//
// This unit is READ-ONLY against the graph (Spec 13 §1/§3/Definition of
// Done): every Neo4j interaction below goes through GraphQueryPort.
// runCypher (created via createGraphQueryPortFromDriver, itself
// read-only — see that function's own doc comment in
// mapping-risk-scoring.graph.ts). No `commitProposal` call and no Neo4j
// write session exist anywhere in this file.
import { randomUUID } from "node:crypto";
import type { AuditLedgerPort } from "@sentinel-act/audit-ledger";
import { PostgresAuditLedger, getPool as getAuditLedgerPool } from "@sentinel-act/audit-ledger";
import { getDriver } from "@sentinel-act/graph-db";
import {
  createStaticRoleAssigneeMap,
  GenericWebhookAdapter,
  getPool as getTicketingPool,
  PostgresTicketingOutboxPort,
  processOutboxOnce as coreProcessOutboxOnce,
  resetOutboxEntry as coreResetOutboxEntry,
  runMigrations,
  ValidationError
} from "@sentinel-act/ticketing-adapter";
import type {
  AppendLedgerEntryPort,
  ObligationCommittedEvent,
  ProcessOutboxResult,
  TicketingAdapter,
  TicketingContext
} from "@sentinel-act/ticketing-adapter";
import { createGraphQueryPortFromDriver } from "../agents/mapping-risk-scoring.graph.js";

// ---------------------------------------------------------------------------
// FR-1..FR-4: intake. Exported as a plain function per Spec 13 §5.1's
// literal placement, delegating the actual insert-if-not-exists logic to
// the (still purely mechanical, DB-shaped) TicketingOutboxPort — the
// validation itself is the only thing that must live here.
// ---------------------------------------------------------------------------

const VALID_FINAL_STATUSES = new Set<ObligationCommittedEvent["final_status"]>(["tier_a_committed", "committed"]);

function validateEvent(event: ObligationCommittedEvent): void {
  if (!VALID_FINAL_STATUSES.has(event.final_status)) {
    throw new ValidationError(
      `final_status must be "tier_a_committed" or "committed", got "${String(event.final_status)}" — FR-1.`,
      "final_status"
    );
  }
  if (!event.event_id || event.event_id.trim().length === 0) {
    throw new ValidationError("event_id is required.", "event_id");
  }
  if (!event.obligation_id || event.obligation_id.trim().length === 0) {
    throw new ValidationError("obligation_id is required.", "obligation_id");
  }
  if (!event.task_id || event.task_id.trim().length === 0) {
    throw new ValidationError("task_id is required.", "task_id");
  }
}

/** FR-1..FR-3: validates `event`, then inserts a `"pending"`
 *  TicketingOutboxEntry keyed on `event.event_id` (unique constraint) — a
 *  redelivery is a no-op returning `{ enqueued: false }`, never an error. */
export async function handleObligationCommittedEvent(
  event: ObligationCommittedEvent,
  ctx: TicketingContext
): Promise<{ enqueued: boolean }> {
  validateEvent(event);
  const { inserted } = await ctx.outbox.insertIfNotExists({
    id: randomUUID(),
    event_id: event.event_id,
    obligation_id: event.obligation_id,
    task_id: event.task_id,
    tier: event.tier
  });
  return { enqueued: inserted };
}

// Re-exported unchanged so a single import surface (this file) covers the
// whole worker/sweep/reset trio, even though processOutboxOnce/
// resetOutboxEntry's actual implementations live in
// packages/ticketing-adapter (they only touch injected ports, no Neo4j —
// see that package's outbox-worker.ts doc comment).
export const processOutboxOnce: (ctx: TicketingContext) => Promise<ProcessOutboxResult> = coreProcessOutboxOnce;
export const resetOutboxEntry: (id: string, ctx: TicketingContext) => Promise<void> = coreResetOutboxEntry;

// ---------------------------------------------------------------------------
// FR-19..FR-21: reconciliation sweep. Lives here (not in
// packages/ticketing-adapter) because it both queries Neo4j directly via
// this app's createGraphQueryPortFromDriver-backed ctx.graph AND calls
// handleObligationCommittedEvent, which per Spec 13 §5.1 is also defined
// in this file — keeping both together avoids a circular/backwards
// package->app dependency.
//
// DEVIATION FROM SPEC TEXT (documented, not silent): FR-20 requires a
// synthesized event to carry `tier`, but `Obligation` (graph-schema) has
// no `tier` field at all — Spec 08's tier decision is never persisted to
// the graph, only `Obligation.status`, and "committed" alone cannot
// distinguish a Tier B single-approval from a Tier C maker-checker
// approval. This sweep infers tier from the number of REVIEWED_BY
// HumanReview edges on the Obligation instead (0 reviews -> the item was
// never routed to human review at all, i.e. Tier A; 1 review -> Tier B;
// 2 reviews -> Tier C) — schema-consistent with graph-schema's own
// documented cardinality note ("a Tier C item carries two" HumanReview
// edges). ESCALATE never appears here: an ESCALATE disagreement resolves
// to Obligation.status "escalated", which never satisfies this query's
// WHERE clause.
// ---------------------------------------------------------------------------

const RECONCILE_CANDIDATES_CYPHER = `
  MATCH (o:Obligation)-[:MAPPED_TO]->(t:ProcessTask)
  WHERE o.status IN ["tier_a_committed", "committed"] AND t.valid_to IS NULL
  OPTIONAL MATCH (o)-[:REVIEWED_BY]->(r:HumanReview)
  WITH o, t, count(r) AS reviewCount
  RETURN o.obligation_id AS obligationId, o.status AS obligationStatus, o.recorded_at AS obligationRecordedAt,
         t.task_id AS taskId, reviewCount
`;

interface ReconcileCandidateRow {
  obligationId: string;
  obligationStatus: "tier_a_committed" | "committed";
  obligationRecordedAt: string | null;
  taskId: string;
  reviewCount: number;
}

function inferTier(reviewCount: number): ObligationCommittedEvent["tier"] {
  if (reviewCount >= 2) {
    return "C";
  }
  if (reviewCount === 1) {
    return "B";
  }
  return "A";
}

/** FR-19..FR-21: finds committed ProcessTasks with neither a TicketMapping
 *  nor an in-flight outbox row, synthesizes a fresh ObligationCommittedEvent
 *  for each (new event_id, all other fields read from current graph
 *  state), and calls handleObligationCommittedEvent — the exact same path
 *  a live trigger uses, so no dedicated ledger entry type is needed for
 *  the sweep itself (FR-21). */
export async function reconcileMissedCommits(ctx: TicketingContext, opts?: { limit?: number }): Promise<{ backfilled: number }> {
  const limit = opts?.limit ?? 100;
  const rows = await ctx.graph.runCypher<ReconcileCandidateRow>(RECONCILE_CANDIDATES_CYPHER, {});

  let backfilled = 0;
  for (const row of rows) {
    if (backfilled >= limit) {
      break;
    }

    // FR-19: exclude tasks that already have a TicketMapping or any
    // in-flight (pending/processing/failed_retryable) outbox row.
    const existingMapping = await ctx.outbox.findMapping(row.taskId);
    if (existingMapping) {
      continue;
    }
    const inFlight = await ctx.outbox.hasInFlightEntryForTask(row.taskId);
    if (inFlight) {
      continue;
    }

    const event: ObligationCommittedEvent = {
      event_id: randomUUID(),
      obligation_id: row.obligationId,
      task_id: row.taskId,
      final_status: row.obligationStatus,
      tier: inferTier(row.reviewCount),
      committed_at: row.obligationRecordedAt ?? ctx.referenceDate
    };

    const { enqueued } = await handleObligationCommittedEvent(event, ctx);
    if (enqueued) {
      backfilled += 1;
    }
  }

  return { backfilled };
}

// ---------------------------------------------------------------------------
// TicketingTriggerPort — the thin wrapper orchestrator.workflow.ts's
// OrchestratorRuntime.ticketing field is typed against (Spec 13 Task 8).
// Deliberately narrow so orchestrator.workflow.ts does not need to import
// this whole file's (or packages/ticketing-adapter's) full construction
// surface — see that file's own OrchestratorRuntime doc comment.
// ---------------------------------------------------------------------------

export interface TicketingTriggerPort {
  handle(event: ObligationCommittedEvent): Promise<{ enqueued: boolean }>;
}

export function createTicketingTriggerPort(ctx: TicketingContext): TicketingTriggerPort {
  return {
    handle: (event) => handleObligationCommittedEvent(event, { ...ctx, referenceDate: new Date().toISOString() })
  };
}

// ---------------------------------------------------------------------------
// Real TicketingContext construction from env (§13 item 7's "colocate
// inside apps/orchestrator" recommended default — no separate service, no
// HTTP endpoint, direct in-process function calls throughout).
// ---------------------------------------------------------------------------

export interface TicketingEnvConfig {
  adapterName: string; // TICKETING_ADAPTER, default "generic-webhook"
  webhookUrl: string | undefined;
  webhookSecret: string | undefined;
  defaultAssigneeRef: string;
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  outboxBatchSize: number;
  outboxPollIntervalMs: number;
  reconcileIntervalMs: number;
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function readTicketingEnvConfig(): TicketingEnvConfig {
  return {
    adapterName: process.env.TICKETING_ADAPTER ?? "generic-webhook",
    webhookUrl: process.env.TICKETING_WEBHOOK_URL || undefined,
    webhookSecret: process.env.TICKETING_WEBHOOK_SECRET || undefined,
    defaultAssigneeRef: process.env.TICKETING_DEFAULT_QUEUE_REF ?? "queue:unassigned",
    maxAttempts: numberFromEnv("TICKETING_MAX_ATTEMPTS", 8),
    baseBackoffMs: numberFromEnv("TICKETING_BASE_BACKOFF_MS", 60_000),
    maxBackoffMs: numberFromEnv("TICKETING_MAX_BACKOFF_MS", 21_600_000),
    outboxBatchSize: numberFromEnv("TICKETING_OUTBOX_BATCH_SIZE", 20),
    outboxPollIntervalMs: numberFromEnv("TICKETING_OUTBOX_POLL_INTERVAL_MS", 30_000),
    reconcileIntervalMs: numberFromEnv("TICKETING_RECONCILE_INTERVAL_MS", 15 * 60 * 1000)
  };
}

function createAdapter(env: TicketingEnvConfig): TicketingAdapter {
  if (env.adapterName !== "generic-webhook") {
    // §5.5: Jira/ServiceNow are documented pluggable alternatives, not
    // built in this spec's scope (§13 item 3) — fail loudly rather than
    // silently falling back to a webhook adapter nobody configured.
    throw new Error(
      `TICKETING_ADAPTER="${env.adapterName}" is not implemented — only "generic-webhook" is built in Spec 13's scope (see §5.5).`
    );
  }
  if (!env.webhookUrl || !env.webhookSecret) {
    throw new Error("TICKETING_WEBHOOK_URL and TICKETING_WEBHOOK_SECRET must both be set for the generic-webhook adapter.");
  }
  return new GenericWebhookAdapter({ url: env.webhookUrl, secret: env.webhookSecret });
}

function createAppendLedgerEntryPort(ledger: Pick<AuditLedgerPort, "append">): AppendLedgerEntryPort {
  return {
    async append(input) {
      const entry = await ledger.append(input);
      return { sequence_number: entry.sequence_number };
    }
  };
}

/** Builds a real, Postgres/Neo4j/HTTP-backed TicketingContext from env.
 *  `referenceDate` is captured at construction time — callers that run
 *  this on a poll loop should refresh it per tick (see
 *  startTicketingBackgroundLoops below), never reusing a stale value
 *  across many hours of process uptime. */
export async function createRealTicketingContext(): Promise<TicketingContext> {
  const env = readTicketingEnvConfig();

  const driver = getDriver();
  const graph = createGraphQueryPortFromDriver(driver);

  const ticketingPool = getTicketingPool();
  await runMigrations(ticketingPool);
  const outbox = new PostgresTicketingOutboxPort(ticketingPool);

  const ledgerPool = getAuditLedgerPool();
  const ledger = createAppendLedgerEntryPort(new PostgresAuditLedger(ledgerPool));

  const adapter = createAdapter(env);
  const roleAssigneeMap = createStaticRoleAssigneeMap();

  return {
    graph,
    adapter,
    roleAssigneeMap,
    outbox,
    ledger,
    referenceDate: new Date().toISOString(),
    config: {
      defaultAssigneeRef: env.defaultAssigneeRef,
      maxAttempts: env.maxAttempts,
      baseBackoffMs: env.baseBackoffMs,
      maxBackoffMs: env.maxBackoffMs,
      outboxBatchSize: env.outboxBatchSize
    }
  };
}

// ---------------------------------------------------------------------------
// Background loops (§13 item 7's "simple setInterval/cron-style loop
// within the same process"). NFR-1's 30s outbox-poll default and §8's
// 15-minute reconciliation-sweep default are both env-configurable
// placeholders (Spec 13 §13 item 4), never hardcoded past this function.
//
// Not wired into apps/orchestrator/src/server/start.ts by this task —
// that file's own header comment documents the same
// "runtime not configured until an operator wires it" posture already
// established for configureOrchestratorRuntime/the SLA reminder
// scheduler. Wiring a call to this function into start.ts (guarded by the
// same "never a fatal process-startup error" convention used there for
// the Slack scheduler) is a one-line follow-up, intentionally left to
// whoever owns that file's next change rather than risking an
// under-informed edit to unrelated bootstrap code here.
// ---------------------------------------------------------------------------

export interface TicketingBackgroundLoopsHandle {
  stop: () => void;
}

function freshCtx(ctx: TicketingContext): TicketingContext {
  return { ...ctx, referenceDate: new Date().toISOString() };
}

export function startTicketingBackgroundLoops(
  ctx: TicketingContext,
  env: Pick<TicketingEnvConfig, "outboxPollIntervalMs" | "reconcileIntervalMs"> = readTicketingEnvConfig()
): TicketingBackgroundLoopsHandle {
  const outboxTimer = setInterval(() => {
    processOutboxOnce(freshCtx(ctx)).catch((error: unknown) => {
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          operation: "ticketing-outbox-poll",
          message: error instanceof Error ? error.message : String(error)
        })
      );
    });
  }, env.outboxPollIntervalMs);

  const reconcileTimer = setInterval(() => {
    reconcileMissedCommits(freshCtx(ctx)).catch((error: unknown) => {
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          operation: "ticketing-reconciliation-sweep",
          message: error instanceof Error ? error.message : String(error)
        })
      );
    });
  }, env.reconcileIntervalMs);

  // Never keep the process alive on their own (mirrors the SLA reminder
  // scheduler's posture in src/slack/sla-reminder-scheduler.ts).
  outboxTimer.unref?.();
  reconcileTimer.unref?.();

  return {
    stop: () => {
      clearInterval(outboxTimer);
      clearInterval(reconcileTimer);
    }
  };
}
