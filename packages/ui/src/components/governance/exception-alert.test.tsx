import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ExceptionAlert } from "./exception-alert";

describe("ExceptionAlert (Spec 14 FR-19, FR-20)", () => {
  it('uses role="alert" for severity=escalate', () => {
    render(<ExceptionAlert severity="escalate" title="Contradiction detected" description="details" />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it('uses role="alert" for severity=sla-breach', () => {
    render(<ExceptionAlert severity="sla-breach" title="SLA missed" description="details" />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it('uses role="status" (polite) for severity=warning', () => {
    render(<ExceptionAlert severity="warning" title="Heads up" description="details" />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("severity=escalate renders with the --risk-escalate token", () => {
    render(<ExceptionAlert severity="escalate" title="Contradiction detected" description="details" />);
    expect(screen.getByRole("alert").className).toMatch(/--risk-escalate/);
  });

  it("renders the structured detail slot (not a plain-string-only prop)", () => {
    render(
      <ExceptionAlert
        severity="escalate"
        title="Contradiction detected"
        description="details"
        detail={<div data-testid="conflict-detail">5 days vs 3 days</div>}
      />
    );
    expect(screen.getByTestId("conflict-detail")).toBeInTheDocument();
  });

  it("escalate example demonstrates only escalate/reject actions, never approve", () => {
    render(
      <ExceptionAlert
        severity="escalate"
        title="Contradiction detected"
        description="details"
        actions={
          <>
            <button>Escalate to Tier C</button>
            <button>Reject</button>
          </>
        }
      />
    );
    expect(screen.getByRole("button", { name: "Escalate to Tier C" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
  });
});
