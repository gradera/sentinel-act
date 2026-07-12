import * as React from "react";

/**
 * Spec 14 FR-23: Dialog/Sheet/AlertDialog instances must be closable via
 * Escape except when a Textarea inside them has uncommitted text (e.g. a
 * Tier C rationale a reviewer just wrote) — in that case Escape (and an
 * outside click) must trigger a confirm-discard step instead of silently
 * closing. Shared by dialog.tsx, sheet.tsx, and alert-dialog.tsx so each
 * primitive's Content component gets the same guard behavior instead of
 * three independent, drift-prone implementations.
 */
export function useUnsavedCloseGuard(hasUnsavedChanges: boolean | undefined) {
  const [confirming, setConfirming] = React.useState(false);

  const guardEscape = React.useCallback(
    (event: { preventDefault: () => void }) => {
      if (hasUnsavedChanges) {
        event.preventDefault();
        setConfirming(true);
      }
    },
    [hasUnsavedChanges]
  );

  const guardOutsideInteract = React.useCallback(
    (event: { preventDefault: () => void }) => {
      if (hasUnsavedChanges) {
        event.preventDefault();
        setConfirming(true);
      }
    },
    [hasUnsavedChanges]
  );

  const cancelDiscard = React.useCallback(() => setConfirming(false), []);

  return { confirming, guardEscape, guardOutsideInteract, cancelDiscard };
}
