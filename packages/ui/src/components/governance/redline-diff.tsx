"use client";

import * as React from "react";
import { diffWords } from "diff";
import { cn } from "@sentinel-act/ui/lib/utils";
import { Button } from "@sentinel-act/ui/components/ui/button";

/**
 * RedlineDiff — the redlined ProcessTask/Obligation comparison the UX
 * brief calls "the screen that has to earn trust" (Journey A step 2):
 * a reviewer's eye must go to what actually changed, not the whole
 * payload (Spec 14 FR-8).
 */

export interface DiffField {
  /** ProcessTask/Obligation field name, e.g. "sla_hours", "owner_role". */
  key: string;
  /** Human label shown above the field, e.g. "SLA (hours)". */
  label: string;
  oldValue: string | number | null;
  newValue: string | number | null;
  /** "text" gets word-level diffing (via the `diff` package); "value"
   *  (default) highlights the whole field as changed/unchanged with no
   *  sub-field diffing. */
  kind?: "text" | "value";
}

export type RedlineDiffMode = "side-by-side" | "inline";

export interface RedlineDiffProps {
  fields: DiffField[];
  /** "side-by-side" (default on >=1024px viewports) shows old | new
   *  columns; "inline" (default below 1024px, and user-toggleable at any
   *  width) shows a single unified redline. */
  mode?: RedlineDiffMode;
  /** Controlled mode toggle; if omitted the component manages its own
   *  toggle state internally (uncontrolled), defaulting per viewport. */
  onModeChange?: (mode: RedlineDiffMode) => void;
  /** Shown when there is no prior version, e.g. "New ProcessTask — no
   *  prior version to compare." Renders in place of the old-value side. */
  emptyOldLabel?: string;
  title?: string;
  className?: string;
}

// Spec 14 §8 edge case: mismatched types (e.g. old is a string, new is a
// number) must never throw — coerce both to String(...) for
// comparison/display.
function coerce(v: string | number | null): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

export function RedlineDiff({ fields, mode: controlledMode, onModeChange, emptyOldLabel, title, className }: RedlineDiffProps) {
  // FR-10: responsive default (>=1024px side-by-side, below inline),
  // always user-toggleable regardless of viewport.
  const [viewportMode, setViewportMode] = React.useState<RedlineDiffMode>("side-by-side");
  React.useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(min-width: 1024px)");
    const update = () => setViewportMode(mq.matches ? "side-by-side" : "inline");
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const [uncontrolledMode, setUncontrolledMode] = React.useState<RedlineDiffMode | null>(null);
  const mode = controlledMode ?? uncontrolledMode ?? viewportMode;

  const setMode = (next: RedlineDiffMode) => {
    onModeChange?.(next);
    if (controlledMode === undefined) setUncontrolledMode(next);
  };

  // FR-11: fields with both oldValue and newValue null are omitted
  // entirely, never shown as an empty diff row.
  const visibleFields = fields.filter((f) => !(f.oldValue === null && f.newValue === null));
  const isNewVersion = Boolean(emptyOldLabel);

  return (
    <div className={cn("rounded-lg border bg-card text-card-foreground", className)} data-slot="redline-diff">
      <div className="flex items-center justify-between gap-4 border-b px-4 py-2">
        {title ? <h4 className="text-sm font-semibold">{title}</h4> : <span />}
        <div className="flex items-center gap-1" role="group" aria-label="Diff view mode">
          <Button
            type="button"
            size="sm"
            variant={mode === "side-by-side" ? "secondary" : "ghost"}
            aria-pressed={mode === "side-by-side"}
            onClick={() => setMode("side-by-side")}
          >
            Side by side
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === "inline" ? "secondary" : "ghost"}
            aria-pressed={mode === "inline"}
            onClick={() => setMode("inline")}
          >
            Inline
          </Button>
        </div>
      </div>

      {/* FR-8 edge case (§8): an empty fields array renders a neutral
          message, not a blank panel. */}
      {visibleFields.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">No changes to display.</p>
      ) : (
        <div>
          {/* FR-12: no prior version at all — one banner at the top of
              the old-value side, not a spurious per-field diff. */}
          {isNewVersion && (
            <p className="border-b bg-muted/50 px-4 py-2 text-xs font-medium text-muted-foreground">{emptyOldLabel}</p>
          )}
          <div className="divide-y">
            {visibleFields.map((field) => (
              <DiffRow key={field.key} field={field} mode={mode} isNewVersion={isNewVersion} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DiffRow({ field, mode, isNewVersion }: { field: DiffField; mode: RedlineDiffMode; isNewVersion: boolean }) {
  const oldStr = isNewVersion ? null : coerce(field.oldValue);
  const newStr = coerce(field.newValue);
  const kind = field.kind ?? "value";
  // FR-9: "value" fields (default) are whole-value equality only, no
  // partial highlighting, regardless of how similar the strings look.
  const changed = isNewVersion || oldStr !== newStr;

  return (
    <div
      className={cn("px-4 py-3", changed && "bg-[hsl(var(--confidence-medium))]/10")}
      data-slot="redline-diff-row"
      data-changed={changed}
    >
      <div className="mb-1 text-xs font-medium text-muted-foreground">{field.label}</div>
      {mode === "side-by-side" ? (
        <SideBySideValue oldStr={oldStr} newStr={newStr} kind={kind} changed={changed} isNewVersion={isNewVersion} />
      ) : (
        <InlineValue oldStr={oldStr} newStr={newStr} kind={kind} changed={changed} isNewVersion={isNewVersion} />
      )}
    </div>
  );
}

interface ValueProps {
  oldStr: string | null;
  newStr: string | null;
  kind: "text" | "value";
  changed: boolean;
  isNewVersion: boolean;
}

function SideBySideValue({ oldStr, newStr, kind, changed, isNewVersion }: ValueProps) {
  if (!changed) {
    return <div className="text-sm text-foreground">{newStr ?? "—"}</div>;
  }

  if (kind === "text" && oldStr !== null && newStr !== null) {
    const parts = diffWords(oldStr, newStr);
    return (
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="rounded bg-[hsl(var(--risk-escalate))]/10 p-2">
          {parts
            .filter((p) => !p.added)
            .map((p, i) => (
              <span key={i} className={cn(p.removed && "bg-[hsl(var(--risk-escalate))]/25 line-through")}>
                {p.value}
              </span>
            ))}
        </div>
        <div className="rounded bg-[hsl(var(--risk-a))]/10 p-2">
          {parts
            .filter((p) => !p.removed)
            .map((p, i) => (
              <span key={i} className={cn(p.added && "bg-[hsl(var(--risk-a))]/25")}>
                {p.value}
              </span>
            ))}
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 text-sm">
      <div className="rounded bg-[hsl(var(--risk-escalate))]/10 p-2 line-through">
        {isNewVersion ? "—" : (oldStr ?? "—")}
      </div>
      <div className="rounded bg-[hsl(var(--risk-a))]/10 p-2">{newStr ?? "—"}</div>
    </div>
  );
}

function InlineValue({ oldStr, newStr, kind, changed, isNewVersion }: ValueProps) {
  if (!changed) {
    return <div className="text-sm text-foreground">{newStr ?? "—"}</div>;
  }

  if (kind === "text" && oldStr !== null && newStr !== null) {
    const parts = diffWords(oldStr, newStr);
    return (
      <div className="text-sm leading-relaxed">
        {parts.map((p, i) => (
          <span
            key={i}
            className={cn(
              p.added && "bg-[hsl(var(--risk-a))]/25",
              p.removed && "bg-[hsl(var(--risk-escalate))]/25 line-through"
            )}
          >
            {p.value}
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-1 text-sm">
      {!isNewVersion && oldStr !== null && (
        <div className="flex gap-2 rounded bg-[hsl(var(--risk-escalate))]/10 px-2 py-1 line-through">
          <span aria-hidden="true">−</span>
          <span>{oldStr}</span>
        </div>
      )}
      <div className="flex gap-2 rounded bg-[hsl(var(--risk-a))]/10 px-2 py-1">
        <span aria-hidden="true">+</span>
        <span>{newStr ?? "—"}</span>
      </div>
    </div>
  );
}
