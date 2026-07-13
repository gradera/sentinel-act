import * as React from "react";
import { cn } from "@sentinel-act/ui/lib/utils";
import type { ReviewDecision } from "@sentinel-act/graph-schema";

/**
 * DecisionBadge — Spec 10 §4.1/§4.2: renders a `HumanReview.decision`
 * ("approve" | "reject"), the Compliance Register's synthetic
 * "auto-committed" value (`ComplianceRegisterRow.decision`, a Tier A
 * obligation with no `HumanReview` fact at all — see FR-14), or `null`
 * (no decision recorded / not applicable). Follows `RiskTierBadge`'s
 * exact structural pattern (a labeled, solid-fill badge, one CSS variable
 * per state) rather than inventing a different shape for this one.
 *
 * Token choice (documented per this component's own design brief: reuse
 * an existing token before adding a new one). There is no dedicated
 * `--success`/`--approve` CSS variable in `globals.css` — Spec 14's token
 * set only defines `--risk-*`, `--confidence-*`, `--urgency-*`, plus the
 * base shadcn `--destructive`. Rather than introduce a new variable for a
 * single badge, this component reuses:
 *
 *  - `--confidence-high` (teal) for "approve" — already this design
 *    system's established "positive / high-trust" signal color
 *    (`ConfidenceBadge`'s own top bucket), so a second, different
 *    "green means good" color is not introduced alongside it.
 *  - `--destructive` (red) for "reject" — already the exact color
 *    Spec 09's `SignOffPanel` uses for its own reject/decline `Button`
 *    (`variant="destructive"`), so an audit trail's rendering of a past
 *    rejection matches the color the reviewer originally saw on the
 *    action that produced it.
 *  - muted/secondary (neutral gray, no risk-tier color) for
 *    "auto-committed". Deliberately NOT `--risk-a` (Tier A's green),
 *    even though this value only ever appears on a Tier A row:
 *    `RiskTierBadge` already renders that green Tier badge alongside this
 *    one wherever both are shown (the Compliance Register), and a second
 *    green badge repeating the same fact would be redundant, not
 *    informative. "auto-committed" means "no human decision was made" —
 *    a neutral fact, not a positive or negative one.
 *  - the same neutral gray for `null` ("no decision recorded" — not
 *    expected on the audit search table, since every row there is joined
 *    off a real `HumanReview`, but handled here since this component is
 *    shared and the Compliance Register's row shape allows it).
 */

export type DecisionValue = ReviewDecision | "auto-committed" | null;

type DecisionKey = "approve" | "reject" | "auto-committed" | "none";

function keyFor(decision: DecisionValue): DecisionKey {
  return decision ?? "none";
}

const DECISION_LABEL: Record<DecisionKey, string> = {
  approve: "Approved",
  reject: "Rejected",
  "auto-committed": "Auto-committed",
  none: "No decision"
};

const DECISION_CLASS: Record<DecisionKey, string> = {
  approve: "bg-[hsl(var(--confidence-high))] text-white",
  reject: "bg-destructive text-destructive-foreground",
  "auto-committed": "bg-muted text-muted-foreground",
  none: "bg-muted text-muted-foreground"
};

export function DecisionBadge({ decision, className }: { decision: DecisionValue; className?: string }) {
  const key = keyFor(decision);
  return (
    <span
      className={cn("inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold", DECISION_CLASS[key], className)}
      title={DECISION_LABEL[key]}
    >
      {DECISION_LABEL[key]}
    </span>
  );
}
