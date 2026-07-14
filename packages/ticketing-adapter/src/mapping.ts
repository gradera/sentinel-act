// Pure mapping functions — FR-5..FR-12. No I/O, no wall-clock reads
// (ctx.referenceDate / caller-supplied values only), fully unit-testable
// without a real Postgres/Neo4j/HTTP dependency. Spec 13 §5.1 places
// these in packages/ticketing-adapter (as opposed to
// handleObligationCommittedEvent, which the spec explicitly places in
// apps/orchestrator/src/mastra/integrations/grc-ticketing.ts).
import type { Obligation, ProcessTask } from "@sentinel-act/graph-schema";
import type { CreateTicketRequest, ObligationCommittedEvent, TicketAssignee, TicketingContext, TicketLineage, TicketPriority } from "./types.js";

// ---------------------------------------------------------------------------
// FR-10: due date. IDENTICAL formula to Spec 07's computeTaskDeadline
// (apps/orchestrator/src/mastra/agents/monitoring-and-audit.agent.ts) —
// reimplemented here (not imported: packages/ticketing-adapter cannot
// depend on apps/orchestrator, the wrong dependency direction) and
// guarded against drift by the shared __fixtures__/deadline.fixture.ts
// table both packages' test suites assert against.
// ---------------------------------------------------------------------------

export function computeTicketDueDate(task: Pick<ProcessTask, "valid_from" | "sla_hours">): string {
  const validFromMs = new Date(task.valid_from).getTime();
  const deadlineMs = validFromMs + task.sla_hours * 60 * 60 * 1000;
  return new Date(deadlineMs).toISOString();
}

// ---------------------------------------------------------------------------
// FR-11: priority mapping — same 0.75/0.4 thresholds as Spec 00 §3's
// routeTier placeholder formula (deliberate consistency choice, not a
// coincidence — see FR-11's rationale). Still an internal placeholder
// pending compliance sign-off, per Spec 00 §3's caveat.
// ---------------------------------------------------------------------------

export function computeTicketPriority(risk_score: number): TicketPriority {
  if (risk_score >= 0.75) {
    return "P1_urgent";
  }
  if (risk_score >= 0.4) {
    return "P2_high";
  }
  return "P3_normal";
}

// ---------------------------------------------------------------------------
// FR-16: exponential backoff schedule, capped.
// ---------------------------------------------------------------------------

export function computeBackoffDelayMs(attempts: number, ctx: Pick<TicketingContext, "config">): number {
  const raw = ctx.config.baseBackoffMs * Math.pow(2, Math.max(attempts, 1) - 1);
  return Math.min(raw, ctx.config.maxBackoffMs);
}

// ---------------------------------------------------------------------------
// FR-7: description composition. Order is load-bearing: requirement_text,
// deadline_rule, evidence_required, penalty_ref (omitted entirely if
// null), then a lineage line built only from fields that resolved.
// ---------------------------------------------------------------------------

export function composeLineageLine(lineage: TicketLineage): string {
  const parts: string[] = [];
  if (lineage.circularTitle) {
    parts.push(lineage.circularTitle);
  }
  if (lineage.circularDateEffective) {
    parts.push(`effective ${lineage.circularDateEffective}`);
  }
  if (lineage.clauseParaRef) {
    parts.push(`para ${lineage.clauseParaRef}`);
  }
  const body = parts.length > 0 ? parts.join(", ") : "lineage unavailable";
  return `**Source:** ${body}`;
}

export function composeDescription(
  obligation: Pick<Obligation, "requirement_text" | "deadline_rule" | "evidence_required" | "penalty_ref">,
  lineage: TicketLineage
): string {
  const lines: string[] = [
    `**Requirement:** ${obligation.requirement_text}`,
    `**Deadline rule:** ${obligation.deadline_rule}`,
    `**Evidence required:** ${obligation.evidence_required}`
  ];
  if (obligation.penalty_ref !== null) {
    lines.push(`**Penalty:** ${obligation.penalty_ref}`);
  }
  lines.push(composeLineageLine(lineage));
  return lines.join("\n\n");
}

// ---------------------------------------------------------------------------
// FR-12: labels — always exactly these three.
// ---------------------------------------------------------------------------

export function composeLabels(event: Pick<ObligationCommittedEvent, "tier">, category: string): string[] {
  return ["sentinel-act", `tier:${event.tier}`, `category:${category}`];
}

// ---------------------------------------------------------------------------
// FR-8: assignee resolution + fallback.
// ---------------------------------------------------------------------------

export async function resolveAssignee(owner_role: string, ctx: Pick<TicketingContext, "roleAssigneeMap" | "config">): Promise<TicketAssignee> {
  const resolved = await ctx.roleAssigneeMap.resolve(owner_role);
  if (resolved) {
    return resolved;
  }
  return {
    externalAssigneeRef: ctx.config.defaultAssigneeRef,
    displayLabel: owner_role,
    isFallback: true
  };
}

// ---------------------------------------------------------------------------
// FR-5..FR-12 composed.
// ---------------------------------------------------------------------------

export async function buildCreateTicketRequest(
  obligation: Obligation,
  task: ProcessTask,
  lineage: TicketLineage,
  event: ObligationCommittedEvent,
  ctx: Pick<TicketingContext, "roleAssigneeMap" | "config">
): Promise<CreateTicketRequest> {
  const assignee = await resolveAssignee(task.owner_role, ctx);

  return {
    dedupeKey: task.task_id,
    title: task.task_name,
    description: composeDescription(obligation, lineage),
    assignee,
    dueDate: computeTicketDueDate(task),
    priority: computeTicketPriority(task.risk_score),
    labels: composeLabels(event, obligation.category),
    sourceRefs: {
      obligation_id: obligation.obligation_id,
      task_id: task.task_id,
      circular_id: lineage.circularId,
      clause_para_ref: lineage.clauseParaRef
    }
  };
}
