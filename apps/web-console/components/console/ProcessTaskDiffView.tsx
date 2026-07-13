"use client";

import * as React from "react";
import { RedlineDiff } from "@sentinel-act/ui/components/governance/redline-diff";
import { Button } from "@sentinel-act/ui/components/ui/button";
import { countChangedFields, deriveDiffFields, deriveEmptyOldLabel, needsDiffToggle } from "@/lib/console/diff-adapter";
import type { ProcessTaskDiff } from "@/lib/console/types";

/**
 * ProcessTaskDiffView — Spec 09 screen 02's full-width redline panel.
 *
 * FR-12: `processTaskDiff === null` on `ObligationDetailResponse` means
 * this Obligation has no `ProcessTask` at all yet (a stricter case than
 * `redline.oldTaskId === null`, which diff-adapter.ts already handles via
 * `RedlineDiff`'s `emptyOldLabel` prop) — that "no ProcessTask node
 * exists to show" state is this component's own responsibility, since
 * `deriveDiffFields`/`deriveEmptyOldLabel` both require a real
 * `ProcessTaskRedline` to operate on.
 *
 * FR-13: side-by-side (always-visible) when 3 or fewer fields carry a
 * real change (`status !== "unchanged"`), switching to a toggled
 * expand/collapse above that threshold — a different axis from
 * `RedlineDiff`'s own side-by-side/inline mode toggle (that one responds
 * to viewport width per screen 02's "RedlineDiff detail" layout note, and
 * remains user-togglable regardless of field count either way). Only
 * applied to a real modification (`overallStatus === "modified"`); a
 * brand-new task (FR-12's plain list) is never collapsed — there is
 * nothing to hide a reviewer from on a first-version obligation.
 *
 * The threshold decision itself (`CHANGED_FIELD_TOGGLE_THRESHOLD`,
 * `countChangedFields`, `needsDiffToggle`) lives in diff-adapter.ts, not
 * here, so it is unit-testable without rendering this component.
 */

export function ProcessTaskDiffView({ processTaskDiff }: { processTaskDiff: ProcessTaskDiff | null }) {
  const [expanded, setExpanded] = React.useState(false);

  if (processTaskDiff === null) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground" data-slot="process-task-diff-view">
        No process task has been proposed for this obligation yet.
      </div>
    );
  }

  const { redline } = processTaskDiff;
  const fields = deriveDiffFields(redline);
  const emptyOldLabel = deriveEmptyOldLabel(redline);
  const isNewTask = emptyOldLabel !== undefined;
  const changedCount = countChangedFields(redline);
  const needsToggle = needsDiffToggle(redline, isNewTask);

  if (!needsToggle) {
    return (
      <div data-slot="process-task-diff-view">
        <RedlineDiff title={isNewTask ? "Proposed process task" : "Process task changes"} fields={fields} emptyOldLabel={emptyOldLabel} />
      </div>
    );
  }

  // FR-13, above-threshold case: collapsed behind an expand/collapse
  // control by default so a dense diff doesn't dominate the page.
  return (
    <div className="rounded-lg border bg-card" data-slot="process-task-diff-view">
      <div className="flex items-center justify-between gap-4 px-4 py-3">
        <p className="text-sm text-muted-foreground">
          {changedCount} fields changed in this process task.
        </p>
        <Button type="button" size="sm" variant="outline" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
          {expanded ? "Hide diff" : "Show diff"}
        </Button>
      </div>
      {expanded && (
        <div className="border-t">
          <RedlineDiff title="Process task changes" fields={fields} emptyOldLabel={emptyOldLabel} className="rounded-none border-0" />
        </div>
      )}
    </div>
  );
}
