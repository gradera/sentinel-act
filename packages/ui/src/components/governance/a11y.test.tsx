import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { axe } from "jest-axe";

import { RiskTierBadge } from "./risk-tier-badge";
import { ConfidenceBadge } from "./confidence-badge";
import { LineageBreadcrumb } from "./lineage-breadcrumb";
import { UrgencyBadge } from "./urgency-badge";
import { RedlineDiff } from "./redline-diff";
import { IndependenceGate } from "./independence-gate";
import { EvidenceUploader } from "./evidence-uploader";
import { ExceptionAlert } from "./exception-alert";

/**
 * Spec 14 FR-25 / Test Plan §10: jest-axe sweep across every governance
 * component — the 3 that predate this spec (RiskTierBadge,
 * ConfidenceBadge, LineageBreadcrumb) plus the 5 this spec adds.
 */
describe("a11y sweep — toHaveNoViolations() across all 8 governance components", () => {
  it("RiskTierBadge", async () => {
    const { container } = render(<RiskTierBadge tier="C" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("ConfidenceBadge", async () => {
    const { container } = render(<ConfidenceBadge score={0.92} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("LineageBreadcrumb", async () => {
    const { container } = render(
      <LineageBreadcrumb steps={[{ label: "Circular", href: "#" }, { label: "Clause", href: "#" }, { label: "Obligation" }]} />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("UrgencyBadge", async () => {
    const { container } = render(<UrgencyBadge level="now" detail="Due in 2h" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("RedlineDiff", async () => {
    const { container } = render(
      <RedlineDiff
        fields={[{ key: "owner_role", label: "Owner role", oldValue: "A", newValue: "B", kind: "value" }]}
        mode="side-by-side"
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("IndependenceGate", async () => {
    const { container } = render(
      <IndependenceGate role="checker" state="in_independent_review">
        <p>Detail view</p>
      </IndependenceGate>
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("EvidenceUploader", async () => {
    const { container } = render(<EvidenceUploader taskId="task-1" onUpload={() => {}} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("ExceptionAlert", async () => {
    const { container } = render(
      <ExceptionAlert severity="escalate" title="Contradiction detected" description="Two obligations disagree." />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
