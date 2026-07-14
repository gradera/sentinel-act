// The outbox worker — processOutboxOnce (FR-13..FR-18) — and the FR-18 ops
// utility, resetOutboxEntry. No I/O primitives of its own beyond what
// TicketingContext's injected ports provide (ctx.outbox/ctx.graph/
// ctx.adapter/ctx.ledger), so this is fully unit-testable against fakes
// and only needs real Postgres/Neo4j/HTTP for the integration suite
// (Spec 13 §10).
import type { Obligation, ProcessTask } from "@sentinel-act/graph-schema";
import { buildCreateTicketRequest, computeBackoffDelayMs } from "./mapping.js";
import { logOperation, logOutboxTransition } from "./logger.js";
import { BUILD_TICKET_LINEAGE_CYPHER } from "./types.js";
import type { TicketingContext, TicketingOutboxEntry } from "./types.js";
import { AdapterCallError } from "./errors.js";

export interface ProcessOutboxResult {
  processed: number;
  succeeded: number;
  failedRetryable: number;
  failedPermanent: number;
}

interface LineageQueryRow {
  o: unknown;
  t: unknown;
  clauseParaRef: string | null;
  circularTitle: string | null;
  circularDateEffective: string | null;
  circularId: string | null;
}

/** Real Neo4j driver rows return whole nodes as `{ properties, labels,
 *  ... }`-shaped objects (same convention documented in
 *  apps/orchestrator/src/mastra/agents/mapping-risk-scoring.graph.ts and
 *  monitoring-and-audit.agent.ts); a hand-rolled fake GraphQueryPort in
 *  unit tests instead returns plain property maps directly. Defensively
 *  unwrap either shape. */
function unwrapNodeProperties<T>(value: unknown): T | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "object" && "properties" in (value as Record<string, unknown>)) {
    return (value as { properties: T }).properties;
  }
  return value as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Unknown/non-adapter errors (e.g. a bug in buildCreateTicketRequest, an
 *  unreachable roleAssigneeMap) default to retryable — a transient
 *  failure is far more likely at hackathon scale than a permanent one,
 *  and retryable is the strictly safer default (bounded by maxAttempts,
 *  never silently lost). */
function classifyError(error: unknown): "retryable" | "permanent" {
  if (error instanceof AdapterCallError) {
    return error.classification;
  }
  return "retryable";
}

async function appendLedgerSafely(ctx: TicketingContext, input: Parameters<TicketingContext["ledger"]["append"]>[0], phase: string, taskId: string, start: number): Promise<void> {
  try {
    await ctx.ledger.append(input);
  } catch (error) {
    // FR-15/§8: a ledger-append failure after the ticket/mapping already
    // succeeded (or after a permanent failure was already recorded) is
    // logged locally only — never retried, never used to undo/duplicate
    // the ticket-creation side effect.
    logOperation({
      operation: "processOutboxOnce",
      entityType: "ProcessTask",
      entityId: taskId,
      outcome: "error",
      durationMs: Date.now() - start,
      detail: { phase, error: errorMessage(error) }
    });
  }
}

async function handleSucceeded(ctx: TicketingContext, row: TicketingOutboxEntry, start: number): Promise<void> {
  await ctx.outbox.markSucceeded(row.id);
  logOutboxTransition({
    outboxId: row.id,
    event_id: row.event_id,
    task_id: row.task_id,
    fromStatus: "processing",
    toStatus: "succeeded",
    attempts: row.attempts,
    durationMs: Date.now() - start
  });
}

async function handleRetryable(ctx: TicketingContext, row: TicketingOutboxEntry, error: string, result: ProcessOutboxResult, start: number): Promise<void> {
  const newAttempts = row.attempts + 1;
  if (newAttempts > ctx.config.maxAttempts) {
    // FR-17: attempts (after increment) exceeds maxAttempts -> permanent,
    // not another retry.
    await handlePermanent(ctx, row, `${error} (exceeded maxAttempts=${ctx.config.maxAttempts})`, result, start);
    return;
  }
  const delayMs = computeBackoffDelayMs(newAttempts, ctx);
  const nextAttemptAt = new Date(new Date(ctx.referenceDate).getTime() + delayMs).toISOString();
  await ctx.outbox.markRetryable(row.id, nextAttemptAt, error);
  result.failedRetryable += 1;
  logOutboxTransition({
    outboxId: row.id,
    event_id: row.event_id,
    task_id: row.task_id,
    fromStatus: "processing",
    toStatus: "failed_retryable",
    attempts: newAttempts,
    durationMs: Date.now() - start
  });
}

async function handlePermanent(ctx: TicketingContext, row: TicketingOutboxEntry, error: string, result: ProcessOutboxResult, start: number): Promise<void> {
  await ctx.outbox.markPermanentFailure(row.id, error);
  result.failedPermanent += 1;
  logOutboxTransition({
    outboxId: row.id,
    event_id: row.event_id,
    task_id: row.task_id,
    fromStatus: "processing",
    toStatus: "failed_permanent",
    attempts: row.attempts + 1,
    durationMs: Date.now() - start
  });
  await appendLedgerSafely(
    ctx,
    {
      event_type: "TICKET_CREATE_FAILED",
      actor: { type: "system", id: "grc-ticketing" },
      entity_ref: { entity_type: "ProcessTask", entity_id: row.task_id },
      payload: { obligation_id: row.obligation_id, task_id: row.task_id, event_id: row.event_id, error }
    },
    "ledger_append_after_permanent_failure",
    row.task_id,
    start
  );
}

/** FR-13..FR-18: claims up to `ctx.config.outboxBatchSize` claimable rows
 *  and processes them sequentially (no intra-batch concurrency, FR-13). */
export async function processOutboxOnce(ctx: TicketingContext): Promise<ProcessOutboxResult> {
  const batch = await ctx.outbox.claimBatch(ctx.config.outboxBatchSize, ctx.referenceDate);
  const result: ProcessOutboxResult = { processed: 0, succeeded: 0, failedRetryable: 0, failedPermanent: 0 };

  for (const row of batch) {
    const start = Date.now();
    result.processed += 1;
    logOutboxTransition({
      outboxId: row.id,
      event_id: row.event_id,
      task_id: row.task_id,
      fromStatus: row.attempts === 0 ? "pending" : "failed_retryable",
      toStatus: "processing",
      attempts: row.attempts,
      durationMs: 0
    });

    try {
      // FR-4: task_id-level idempotency check, BEFORE ever calling
      // adapter.createTicket.
      const existingMapping = await ctx.outbox.findMapping(row.task_id);
      if (existingMapping) {
        await handleSucceeded(ctx, row, start);
        result.succeeded += 1;
        continue;
      }

      // FR-5: resolve Obligation/ProcessTask/lineage via the read-only
      // Cypher lookup.
      const lineageRows = await ctx.graph.runCypher<LineageQueryRow>(BUILD_TICKET_LINEAGE_CYPHER, {
        obligationId: row.obligation_id,
        taskId: row.task_id
      });
      if (lineageRows.length === 0) {
        await handlePermanent(
          ctx,
          row,
          `Obligation "${row.obligation_id}" / ProcessTask "${row.task_id}" no longer resolves via the read-only lookup — append-only graph model, will never resolve on a later retry.`,
          result,
          start
        );
        continue;
      }

      const obligation = unwrapNodeProperties<Obligation>(lineageRows[0].o);
      const task = unwrapNodeProperties<ProcessTask>(lineageRows[0].t);
      if (!obligation || !task) {
        await handlePermanent(ctx, row, "Malformed Obligation/ProcessTask row returned by the lineage lookup.", result, start);
        continue;
      }

      const request = await buildCreateTicketRequest(
        obligation,
        task,
        {
          clauseParaRef: lineageRows[0].clauseParaRef,
          circularTitle: lineageRows[0].circularTitle,
          circularDateEffective: lineageRows[0].circularDateEffective,
          circularId: lineageRows[0].circularId
        },
        {
          event_id: row.event_id,
          obligation_id: row.obligation_id,
          task_id: row.task_id,
          final_status: row.tier === "A" ? "tier_a_committed" : "committed",
          tier: row.tier,
          committed_at: row.created_at
        },
        ctx
      );

      let createResult;
      try {
        createResult = await ctx.adapter.createTicket(request);
      } catch (error) {
        if (classifyError(error) === "retryable") {
          await handleRetryable(ctx, row, errorMessage(error), result, start);
        } else {
          await handlePermanent(ctx, row, errorMessage(error), result, start);
        }
        continue;
      }

      // FR-15: (a) insertMapping, (b) markSucceeded, (c) ledger.append —
      // in this exact order. If (a) reports { inserted: false } (FR-4's
      // rare race), the row is still marked succeeded and no attempt is
      // made to delete/reconcile the redundant external ticket.
      await ctx.outbox.insertMapping({
        task_id: row.task_id,
        adapter_name: ctx.adapter.adapterName,
        external_ticket_id: createResult.externalTicketId,
        external_ticket_url: createResult.externalTicketUrl,
        created_at: ctx.referenceDate
      });
      await handleSucceeded(ctx, row, start);
      result.succeeded += 1;

      await appendLedgerSafely(
        ctx,
        {
          event_type: "TICKET_CREATED",
          actor: { type: "system", id: "grc-ticketing" },
          entity_ref: { entity_type: "ProcessTask", entity_id: row.task_id },
          payload: {
            obligation_id: row.obligation_id,
            task_id: row.task_id,
            event_id: row.event_id,
            adapter_name: ctx.adapter.adapterName,
            external_ticket_id: createResult.externalTicketId,
            external_ticket_url: createResult.externalTicketUrl
          }
        },
        "ledger_append_after_success",
        row.task_id,
        start
      );
    } catch (error) {
      // Defensive catch-all: an unexpected error anywhere in this row's
      // processing (e.g. a bug in buildCreateTicketRequest, an
      // unreachable roleAssigneeMap) is treated as retryable — the
      // strictly safer default, bounded by maxAttempts.
      await handleRetryable(ctx, row, errorMessage(error), result, start);
    }
  }

  return result;
}

/** FR-18: resets a `"failed_permanent"` row to `"pending"`/`attempts: 0`/
 *  `last_error: null` so the next `processOutboxOnce` call picks it up
 *  again. Independently callable from a script or a future ops screen —
 *  no UI is built for it in this spec's scope. */
export async function resetOutboxEntry(id: string, ctx: Pick<TicketingContext, "outbox">): Promise<void> {
  await ctx.outbox.resetToPending(id);
}
