// Maps Spec 06's real `ProcessTaskRedline`/`ProcessTaskFieldDiff` (see
// types.ts's structural copy + doc comment on why it can't be a direct
// import) to packages/ui's `RedlineDiff` component's `DiffField[]` prop
// shape (redline-diff.tsx): `{ key, label, oldValue, newValue, kind? }`.
import type { DiffField } from "@sentinel-act/ui/components/governance/redline-diff";
import type { ProcessTaskFieldDiff, ProcessTaskRedline } from "./types";

/** Human labels for the 5 fixed `ProcessTask` fields Spec 06 always
 *  diffs (`ProcessTaskRedline.fields` "always exactly 5 entries, one per
 *  ProcessTask field" per change-and-delta.types.ts's own doc comment).
 *  Named export so a later stage (or a test) can assert exhaustiveness
 *  without re-deriving this table. */
export const PROCESS_TASK_FIELD_LABELS: Record<ProcessTaskFieldDiff["field"], string> = {
  task_name: "Task Name",
  owner_role: "Owner Role",
  sla_hours: "SLA (hours)",
  system_touchpoint: "System Touchpoint",
  risk_score: "Risk Score"
};

/** `task_name` is free-form descriptive text worth word-level diffing
 *  (`kind: "text"`, uses `RedlineDiff`'s `diffWords` path); the other 4
 *  fields are short values/enums/numbers where whole-value highlighting
 *  is more legible than a word-diff (`kind: "value"`, `RedlineDiff`'s
 *  default). */
const TEXT_DIFF_FIELDS: ReadonlySet<ProcessTaskFieldDiff["field"]> = new Set(["task_name"]);

function toDiffFieldKind(field: ProcessTaskFieldDiff["field"]): "text" | "value" {
  return TEXT_DIFF_FIELDS.has(field) ? "text" : "value";
}

/** FR-11: `RedlineDiff` MUST show every entry in `fields[]`, including
 *  `status: "unchanged"` ones (de-emphasized, not hidden) — so this is a
 *  1:1 map, not a filter. `RedlineDiff` itself only ever drops a field
 *  when BOTH `oldValue`/`newValue` are `null` (its own FR-11 edge case,
 *  redline-diff.tsx), which cannot happen for these 5 fields on a real
 *  `ProcessTaskRedline` (every field always has at least a `newValue`). */
export function deriveDiffFields(redline: ProcessTaskRedline): DiffField[] {
  return redline.fields.map(
    (field): DiffField => ({
      key: field.field,
      label: PROCESS_TASK_FIELD_LABELS[field.field],
      oldValue: field.oldValue,
      newValue: field.newValue,
      kind: toDiffFieldKind(field.field)
    })
  );
}

/** FR-12: when `redline.oldTaskId === null` (a first-version Obligation,
 *  no prior `ProcessTask` to diff against — Spec 06's `overallStatus:
 *  "new"` / `oldTaskId: null` case), the panel must render a plain "New
 *  task" list, NOT an empty diff or a diff against a misleading null
 *  baseline. `RedlineDiff` already has first-class support for exactly
 *  this via its `emptyOldLabel` prop (redline-diff.tsx: when set, it
 *  forces every row's old-side to render as the banner instead of a
 *  per-field "changed from nothing" comparison) — this helper is the
 *  single place that decides whether to pass it, so a later UI stage
 *  never has to re-derive the "is this a new task" check itself:
 *
 *    <RedlineDiff
 *      fields={deriveDiffFields(redline)}
 *      emptyOldLabel={deriveEmptyOldLabel(redline)}
 *    />
 *
 *  Returns `undefined` (not passing the prop at all) for a real
 *  modification, so `RedlineDiff`'s own default (side-by-side diff)
 *  behavior is unaffected. */
export function deriveEmptyOldLabel(redline: ProcessTaskRedline): string | undefined {
  if (redline.oldTaskId !== null) {
    return undefined;
  }
  return "New ProcessTask — no prior version to compare.";
}

// ---------------------------------------------------------------------------
// FR-13: inline-vs-toggled diff display threshold.
//
// Extracted out of ProcessTaskDiffView.tsx (Spec 09 Task 11 test-writing
// stage) so the "how many changed fields before we collapse the diff behind
// a toggle" decision is a plain, unit-testable function rather than logic
// only reachable by rendering the component. Previously the component
// computed `changedCount` itself by re-deriving `deriveDiffFields(redline)`
// and then re-matching each `DiffField` back to its source
// `ProcessTaskFieldDiff` by `.key === .field` to read `.status` — needlessly
// indirect, since `redline.fields` already carries `.status` directly. This
// version reads `redline.fields` straight, no round-trip through
// `deriveDiffFields`.
// ---------------------------------------------------------------------------

/** FR-13's threshold: side-by-side (always-visible) when 3 or fewer fields
 *  carry a real change; above that, the panel collapses behind an
 *  expand/collapse toggle by default. Named exported constant, not a magic
 *  number inlined at each call site, matching this codebase's convention for
 *  every other unconfirmed-placeholder threshold (sla.ts's
 *  `SLA_DUE_SOON_WINDOW_HOURS`, risk-score.scorer.ts's
 *  `RISK_TIER_C_THRESHOLD`). */
export const CHANGED_FIELD_TOGGLE_THRESHOLD = 3;

/** Number of `redline.fields` entries whose `status !== "unchanged"` — i.e.
 *  "added", "removed", or "changed". `ProcessTaskRedline.fields` always has
 *  exactly 5 entries (one per fixed `ProcessTask` field, per that type's own
 *  doc comment), so this is always in `0..5`. */
export function countChangedFields(redline: ProcessTaskRedline): number {
  return redline.fields.filter((field) => field.status !== "unchanged").length;
}

/** FR-13: whether `ProcessTaskDiffView` should render the collapsed
 *  toggle-behind-a-button layout instead of the always-visible side-by-side
 *  layout. Only ever `true` for a real modification — a brand-new task
 *  (`isNewTask: true`, FR-12's plain list) is never collapsed, since there
 *  is nothing to hide a reviewer from on a first-version obligation; callers
 *  must pass whatever they already computed for "is this a new task" (e.g.
 *  `deriveEmptyOldLabel(redline) !== undefined`) rather than this function
 *  re-deriving it, so the two checks can never disagree with each other. */
export function needsDiffToggle(redline: ProcessTaskRedline, isNewTask: boolean): boolean {
  if (isNewTask) {
    return false;
  }
  return countChangedFields(redline) > CHANGED_FIELD_TOGGLE_THRESHOLD;
}
