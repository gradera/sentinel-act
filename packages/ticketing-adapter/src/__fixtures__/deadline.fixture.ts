// Shared drift-guard fixture (FR-10, Spec 13 §10's Test Plan requirement):
// "table-driven against Spec 07's computeTaskDeadline fixture values,
// asserting identical output for identical input." Both
// apps/orchestrator's monitoring-and-audit.agent.test.ts (Spec 07's own
// computeTaskDeadline) and this package's mapping.test.ts
// (computeTicketDueDate) assert against this exact table so the two
// formulas — implemented independently, since packages/ticketing-adapter
// cannot import apps/orchestrator code (wrong dependency direction) —
// can never silently drift apart.
export interface DeadlineFixtureCase {
  name: string;
  valid_from: string;
  sla_hours: number;
  expected: string;
}

export const DEADLINE_FIXTURE: DeadlineFixtureCase[] = [
  {
    name: "whole-hour sla_hours",
    valid_from: "2026-07-01T00:00:00.000Z",
    sla_hours: 48,
    expected: "2026-07-03T00:00:00.000Z"
  },
  {
    name: "fractional-hour sla_hours",
    valid_from: "2026-07-01T00:00:00.000Z",
    sla_hours: 1.5,
    expected: "2026-07-01T01:30:00.000Z"
  },
  {
    name: "zero sla_hours (deadline equals valid_from)",
    valid_from: "2026-07-05T12:00:00.000Z",
    sla_hours: 0,
    expected: "2026-07-05T12:00:00.000Z"
  },
  {
    name: "large sla_hours spanning multiple days",
    valid_from: "2026-01-01T00:00:00.000Z",
    sla_hours: 168,
    expected: "2026-01-08T00:00:00.000Z"
  },
  {
    name: "non-midnight valid_from",
    valid_from: "2026-07-13T09:15:30.000Z",
    sla_hours: 4,
    expected: "2026-07-13T13:15:30.000Z"
  }
];
