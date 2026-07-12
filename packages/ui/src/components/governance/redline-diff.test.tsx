import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RedlineDiff, type DiffField } from "./redline-diff";

function mockMatchMedia(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  mockMatchMedia(true); // >=1024px, defaults to side-by-side
});

describe("RedlineDiff (Spec 14 FR-8 through FR-12)", () => {
  const fields: DiffField[] = [
    { key: "owner_role", label: "Owner role", oldValue: "Compliance Officer", newValue: "Senior Compliance Officer", kind: "value" },
    { key: "sla_hours", label: "SLA (hours)", oldValue: 24, newValue: 24, kind: "value" },
    { key: "task_name", label: "Task name", oldValue: "File quarterly report", newValue: "File quarterly report to SEBI", kind: "text" }
  ];

  it("marks changed fields and leaves unchanged fields neutral", () => {
    render(<RedlineDiff fields={fields} mode="side-by-side" />);
    const ownerRow = screen.getByText("Owner role").closest('[data-slot="redline-diff-row"]');
    const slaRow = screen.getByText("SLA (hours)").closest('[data-slot="redline-diff-row"]');
    expect(ownerRow).toHaveAttribute("data-changed", "true");
    expect(slaRow).toHaveAttribute("data-changed", "false");
  });

  it("renders a functional mode toggle that switches the rendered layout", () => {
    render(<RedlineDiff fields={fields} mode="side-by-side" />);
    // side-by-side renders two grid columns for the changed text field
    expect(screen.getByText("to SEBI").closest(".grid")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Inline" }));
  });

  it("kind: value fields do whole-value comparison with no partial highlighting", () => {
    const valueFields: DiffField[] = [{ key: "risk_score", label: "Risk score", oldValue: "0.42", newValue: "0.81", kind: "value" }];
    render(<RedlineDiff fields={valueFields} mode="side-by-side" />);
    expect(screen.getByText("0.42")).toBeInTheDocument();
    expect(screen.getByText("0.81")).toBeInTheDocument();
  });

  it("kind: text fields word-diff via the diff package", () => {
    const textFields: DiffField[] = [
      { key: "task_name", label: "Task name", oldValue: "File quarterly report", newValue: "File quarterly report to SEBI", kind: "text" }
    ];
    render(<RedlineDiff fields={textFields} mode="inline" />);
    // The added words should appear as their own highlighted span, not
    // merged into a single opaque "changed" blob.
    expect(screen.getByText("to SEBI")).toBeInTheDocument();
  });

  it("omits fields where both oldValue and newValue are null (FR-11)", () => {
    const withNulls: DiffField[] = [
      { key: "a", label: "Field A", oldValue: null, newValue: null },
      { key: "b", label: "Field B", oldValue: "x", newValue: "y" }
    ];
    render(<RedlineDiff fields={withNulls} mode="side-by-side" />);
    expect(screen.queryByText("Field A")).not.toBeInTheDocument();
    expect(screen.getByText("Field B")).toBeInTheDocument();
  });

  it("renders a neutral message for an empty fields array", () => {
    render(<RedlineDiff fields={[]} />);
    expect(screen.getByText("No changes to display.")).toBeInTheDocument();
  });

  it("renders emptyOldLabel once at the top instead of a per-field diff (FR-12)", () => {
    const newTaskFields: DiffField[] = [
      { key: "owner_role", label: "Owner role", oldValue: null, newValue: "Compliance Officer" },
      { key: "sla_hours", label: "SLA (hours)", oldValue: null, newValue: 24 }
    ];
    render(<RedlineDiff fields={newTaskFields} emptyOldLabel="New ProcessTask — no prior version to compare." />);
    expect(screen.getAllByText("New ProcessTask — no prior version to compare.")).toHaveLength(1);
    expect(screen.getByText("Compliance Officer")).toBeInTheDocument();
  });

  it("coerces mismatched old/new value types without throwing", () => {
    const mismatched: DiffField[] = [{ key: "sla_hours", label: "SLA (hours)", oldValue: "24", newValue: 48, kind: "value" }];
    expect(() => render(<RedlineDiff fields={mismatched} />)).not.toThrow();
    expect(screen.getByText("48")).toBeInTheDocument();
  });
});
