import * as React from "react";
import { cn } from "@sentinel-act/ui/lib/utils";

/**
 * ReadOnlyBanner — shared "this surface is read-only" chrome, generalized
 * from the exact dashed-border treatment already used inline on
 * `apps/web-console/app/(assistant)/assistant/page.tsx`:
 *
 *   <div className="rounded-md border border-dashed border-muted-foreground/40 p-4">
 *
 * (that page's own comment: "the dashed border is intentional, matching
 * the Observability Console's treatment in the architecture diagram").
 *
 * Both the Figma screen spec (§10 "Audit / history lookup" and §11
 * "Conversational Assistant panel") and the UX brief (§5 Journey F) are
 * explicit that Observer mode's audit screen (Spec 10, this component's
 * first consumer) and the future Conversational Assistant panel (Spec 12)
 * must share the *same* muted, unmistakably-not-a-governance-action
 * visual language — "Same muted/read-only visual treatment as screen 10
 * — this must never be visually confusable with a governance action
 * surface." Extracting the treatment into one shared component (instead
 * of leaving it hand-rolled inline on the Assistant page and re-invented
 * again here) is what keeps the two surfaces from drifting apart as each
 * spec's own screen evolves independently.
 *
 * Deliberately renders no button, link, or form of any kind — it is
 * chrome only, never a control (Spec 10 FR-20).
 */
export function ReadOnlyBanner({
  title = "Observer mode — read only",
  children,
  className
}: {
  title?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-md border border-dashed border-muted-foreground/40 p-4", className)} role="note">
      <h2 className="text-sm font-semibold">{title}</h2>
      {children ? <div className="mt-1 text-sm text-muted-foreground">{children}</div> : null}
    </div>
  );
}
