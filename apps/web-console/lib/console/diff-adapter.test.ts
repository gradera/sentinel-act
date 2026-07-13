// Spec 09 §12: "the diff inline/toggle threshold at 3 changed fields" —
// extracted (this test-writing stage) from ProcessTaskDiffView.tsx into
// diff-adapter.ts's `countChangedFields`/`needsDiffToggle` specifically so
// this is unit-testable without rendering React. Also covers
// `deriveDiffFields`/`deriveEmptyOldLabel`'s existing FR-11/FR-12 mapping
// logic for completeness.
import { describe, expect, it } from "vitest";
import {
  CHANGED_FIELD_TOGGLE_THRESHOLD,
  countChangedFields,
  deriveDiffFields,
  deriveEmptyOldLabel,
  needsDiffToggle
} from "./diff-adapter";
import type { ProcessTaskFieldDiff, ProcessTaskRedline } from "./types";

function makeRedline(statuses: ProcessTaskFieldDiff["status"][], oldTaskId: string | null = "task-1"): ProcessTaskRedline {
  const fieldNames: ProcessTaskFieldDiff["field"][] = ["task_name", "owner_role", "sla_hours", "system_touchpoint", "risk_score"];
  const fields: ProcessTaskFieldDiff[] = fieldNames.map((field, i) => ({
    field,
    oldValue: "old",
    newValue: "new",
    status: statuses[i] ?? "unchanged"
  }));
  return {
    oldTaskId,
    oldObligationId: oldTaskId ? "obligation-old" : null,
    newProcessTaskDraft: {
      obligation_id: "obligation-1",
      task_name: "Do the thing",
      owner_role: "Compliance",
      sla_hours: 24,
      system_touchpoint: "CRM",
      risk_score: 0.5
    },
    newObligationProposal: {},
    fields,
    overallStatus: oldTaskId ? "modified" : "new"
  };
}

describe("countChangedFields", () => {
  it("counts 'changed'/'added'/'removed' but not 'unchanged'", () => {
    const redline = makeRedline(["changed", "unchanged", "added", "removed", "unchanged"]);
    expect(countChangedFields(redline)).toBe(3);
  });

  it("returns 0 when every field is unchanged", () => {
    const redline = makeRedline(["unchanged", "unchanged", "unchanged", "unchanged", "unchanged"]);
    expect(countChangedFields(redline)).toBe(0);
  });

  it("returns 5 when every field changed", () => {
    const redline = makeRedline(["changed", "changed", "changed", "changed", "changed"]);
    expect(countChangedFields(redline)).toBe(5);
  });
});

// FR-13: side-by-side (inline) layout when 3 or fewer fields changed;
// toggled (collapsed) layout above that threshold. A brand-new task is
// never collapsed (FR-12 takes precedence — nothing to hide on a
// first-version obligation).
describe("needsDiffToggle", () => {
  it("threshold constant is 3 (FR-13)", () => {
    expect(CHANGED_FIELD_TOGGLE_THRESHOLD).toBe(3);
  });

  it("is false at exactly the threshold (3 changed fields)", () => {
    const redline = makeRedline(["changed", "changed", "changed", "unchanged", "unchanged"]);
    expect(countChangedFields(redline)).toBe(3);
    expect(needsDiffToggle(redline, false)).toBe(false);
  });

  it("is true just above the threshold (4 changed fields)", () => {
    const redline = makeRedline(["changed", "changed", "changed", "changed", "unchanged"]);
    expect(countChangedFields(redline)).toBe(4);
    expect(needsDiffToggle(redline, false)).toBe(true);
  });

  it("is false below the threshold (2 changed fields)", () => {
    const redline = makeRedline(["changed", "changed", "unchanged", "unchanged", "unchanged"]);
    expect(needsDiffToggle(redline, false)).toBe(false);
  });

  it("is ALWAYS false for a new task (isNewTask: true), even with 5 changed/added fields", () => {
    const redline = makeRedline(["added", "added", "added", "added", "added"], null);
    expect(countChangedFields(redline)).toBe(5);
    expect(needsDiffToggle(redline, true)).toBe(false);
  });
});

// FR-11: when processTaskDiff !== null, the redline diff MUST show every
// entry in fields[] — unchanged entries stay listed (de-emphasized in the
// UI, not hidden), so a reviewer sees the whole proposed task.
describe("deriveDiffFields", () => {
  it("maps all 5 fields 1:1, including unchanged ones (FR-11: never hidden)", () => {
    const redline = makeRedline(["changed", "unchanged", "unchanged", "unchanged", "unchanged"]);
    const fields = deriveDiffFields(redline);
    expect(fields).toHaveLength(5);
    expect(fields.map((f) => f.key)).toEqual(["task_name", "owner_role", "sla_hours", "system_touchpoint", "risk_score"]);
  });

  it("gives task_name kind 'text' (word-diffable) and every other field kind 'value'", () => {
    const redline = makeRedline(["changed", "changed", "changed", "changed", "changed"]);
    const fields = deriveDiffFields(redline);
    const byKey = Object.fromEntries(fields.map((f) => [f.key, f.kind]));
    expect(byKey.task_name).toBe("text");
    expect(byKey.owner_role).toBe("value");
    expect(byKey.sla_hours).toBe("value");
    expect(byKey.system_touchpoint).toBe("value");
    expect(byKey.risk_score).toBe("value");
  });
});

// FR-12: when there is no prior ProcessTask to diff against (oldTaskId ===
// null), the panel must render a plain "New task" list rather than an
// empty/misleading diff. See also items/[obligationId]/route.test.ts for
// the route-assembly-level half of FR-12 (when there is no ProcessTask at
// all, processTaskDiff itself is null).
describe("deriveEmptyOldLabel", () => {
  it("returns undefined for a real modification (oldTaskId set)", () => {
    const redline = makeRedline(["changed", "unchanged", "unchanged", "unchanged", "unchanged"], "task-1");
    expect(deriveEmptyOldLabel(redline)).toBeUndefined();
  });

  it("returns a 'New task' label when oldTaskId is null", () => {
    const redline = makeRedline(["added", "added", "added", "added", "added"], null);
    expect(deriveEmptyOldLabel(redline)).toBe("New ProcessTask — no prior version to compare.");
  });
});
