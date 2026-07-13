import { ExceptionAlert } from "@sentinel-act/ui/components/governance/exception-alert";
import { RedlineDiff } from "@sentinel-act/ui/components/governance/redline-diff";
import type { DiffField } from "@sentinel-act/ui/components/governance/redline-diff";
import type { ContradictionDetail } from "@/lib/console/types";

/**
 * ContradictionPanel — Spec 09 screen 07 (FR-15/16). Rendered above the
 * normal source/obligation/diff panels on an ESCALATE item, highest
 * visual priority on the page.
 *
 * FR-15: never a generic "conflict detected" banner — the two conflicting
 * values are shown as data, via a `RedlineDiff`-style comparison of the
 * single `divergent_field`, not prose the reviewer has to parse.
 *
 * Structurally never offers an approve action: this component does not
 * accept, forward, or render any decision-action prop at all (unlike
 * `ExceptionAlert`, whose `actions` slot exists for callers that want
 * one) — the only actions available for an ESCALATE item ("Escalate to
 * Tier C" / "Reject") live in `SignOffPanel`, which independently never
 * offers "approve" for this tier (FR-27). There is therefore no prop on
 * this component through which an approve action could reach the
 * rendered page, not merely a disabled one.
 */

const DIVERGENT_FIELD_LABEL: Record<ContradictionDetail["divergent_field"], string> = {
  deadline_rule: "Deadline Rule",
  requirement_text: "Requirement Text",
  penalty_ref: "Penalty Reference"
};

export function ContradictionPanel({ contradiction }: { contradiction: ContradictionDetail }) {
  const label = DIVERGENT_FIELD_LABEL[contradiction.divergent_field];
  const field: DiffField = {
    key: contradiction.divergent_field,
    label,
    oldValue: contradiction.existing_value,
    newValue: contradiction.proposed_value,
    kind: contradiction.divergent_field === "requirement_text" ? "text" : "value"
  };

  return (
    <ExceptionAlert
      severity="escalate"
      title="Contradiction detected — this obligation conflicts with an existing one"
      description={
        <div className="space-y-1">
          <p>{contradiction.explanation}</p>
          <p className="text-xs text-muted-foreground">
            Conflicts with obligation {contradiction.conflicting_obligation_id}: {contradiction.conflicting_obligation_summary}
          </p>
        </div>
      }
      detail={
        <RedlineDiff
          title={`${label} — existing obligation vs. this obligation`}
          fields={[field]}
        />
      }
    />
  );
}
