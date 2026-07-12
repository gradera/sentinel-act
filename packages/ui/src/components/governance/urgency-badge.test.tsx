import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { UrgencyBadge } from "./urgency-badge";

describe("UrgencyBadge (Spec 14 FR-6, FR-7, FR-22)", () => {
  it("renders a title attribute and a visible text label for level=now", () => {
    render(<UrgencyBadge level="now" detail="Due in 2h 15m" />);
    const badge = screen.getByTitle(/Now — Due in 2h 15m/);
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("Due in 2h 15m");
  });

  it("renders a visible text label for level=in-motion", () => {
    render(<UrgencyBadge level="in-motion" detail="Due in 3 days" />);
    expect(screen.getByText("Due in 3 days")).toBeInTheDocument();
  });

  it("renders the level name as the label when no detail is provided (level=archive)", () => {
    render(<UrgencyBadge level="archive" />);
    expect(screen.getByText("Archive")).toBeInTheDocument();
    expect(screen.getByTitle("Archive")).toBeInTheDocument();
  });

  it("renders a distinct icon per level (not just a colored span)", () => {
    const { container: nowContainer } = render(<UrgencyBadge level="now" detail="x" />);
    const { container: motionContainer } = render(<UrgencyBadge level="in-motion" detail="x" />);
    const { container: archiveContainer } = render(<UrgencyBadge level="archive" />);
    expect(nowContainer.querySelector("svg")).toBeInTheDocument();
    expect(motionContainer.querySelector("svg")).toBeInTheDocument();
    expect(archiveContainer.querySelector("svg")).toBeInTheDocument();
  });

  it("never uses --risk-* tokens (FR-7): only --urgency-* bracket classes appear", () => {
    for (const level of ["now", "in-motion", "archive"] as const) {
      const { container } = render(<UrgencyBadge level={level} detail="x" />);
      const span = container.firstChild as HTMLElement;
      expect(span.className).toMatch(/--urgency-/);
      expect(span.className).not.toMatch(/--risk-/);
    }
  });
});
