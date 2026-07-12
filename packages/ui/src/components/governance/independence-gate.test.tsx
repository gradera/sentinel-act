import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { IndependenceGate, type IndependenceState, type ReviewerRole } from "./independence-gate";
import type { HumanReview } from "@sentinel-act/graph-schema";

const makerReview: HumanReview = {
  review_id: "rev-1",
  obligation_id: "ob-1",
  reviewer_id: "compliance.officer@example.com",
  tier: "C",
  decision: "approve",
  rationale: "Matches clause 4.2, no penalty ambiguity.",
  decided_at: "2026-07-10T10:00:00.000Z",
  valid_from: "2026-07-10",
  valid_to: null,
  recorded_at: "2026-07-10T10:00:00.000Z"
};

const checkerReview: HumanReview = {
  ...makerReview,
  review_id: "rev-2",
  reviewer_id: "senior.officer@example.com",
  decided_at: "2026-07-10T14:00:00.000Z"
};

afterEach(() => {
  vi.restoreAllMocks();
});

const STATES: IndependenceState[] = ["awaiting_assignment", "in_independent_review", "revealed"];
const ROLES: ReviewerRole[] = ["maker", "checker"];

describe("IndependenceGate (Spec 14 FR-13 through FR-16) — 6 role x state combinations", () => {
  for (const role of ROLES) {
    for (const state of STATES) {
      it(`role=${role} state=${state} renders correct copy and children`, () => {
        const reviews = state === "revealed" ? ([makerReview, checkerReview] as [HumanReview, HumanReview]) : undefined;
        render(
          <IndependenceGate role={role} state={state} reviews={reviews}>
            <div>Detail view content</div>
          </IndependenceGate>
        );

        expect(screen.getByText("Detail view content")).toBeInTheDocument();

        if (state === "awaiting_assignment") {
          expect(screen.getByText("Awaiting a second, independent reviewer.")).toBeInTheDocument();
        } else if (state === "in_independent_review") {
          expect(
            screen.getByText(
              "You are reviewing independently — the other reviewer's decision is hidden until you submit yours."
            )
          ).toBeInTheDocument();
        } else {
          expect(screen.getByText("Both independent reviews are in.")).toBeInTheDocument();
          expect(screen.getByText(makerReview.reviewer_id)).toBeInTheDocument();
          expect(screen.getByText(checkerReview.reviewer_id)).toBeInTheDocument();
        }
      });
    }
  }

  it("FR-14: role=maker in a non-revealed state never renders any second-reviewer progress/assignment UI", () => {
    render(
      <IndependenceGate role="maker" state="awaiting_assignment">
        <div>Detail view content</div>
      </IndependenceGate>
    );
    expect(screen.queryByText(/progress/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/assigned/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("FR-16: refuses to render anything, including children, when reviews is populated outside state=revealed", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(
      <IndependenceGate role="checker" state="in_independent_review" reviews={[makerReview, checkerReview]}>
        <div>Detail view content</div>
      </IndependenceGate>
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("Detail view content")).not.toBeInTheDocument();
    expect(screen.queryByText(makerReview.reviewer_id)).not.toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toMatch(/reviews.*was provided while state/i);
  });

  it("FR-16: re-renders cleanly once state transitions to revealed (no stale hidden-banner leftovers)", () => {
    const { rerender } = render(
      <IndependenceGate role="checker" state="in_independent_review">
        <div>Detail view content</div>
      </IndependenceGate>
    );
    expect(screen.getByText(/reviewing independently/)).toBeInTheDocument();

    rerender(
      <IndependenceGate role="checker" state="revealed" reviews={[makerReview, checkerReview]}>
        <div>Detail view content</div>
      </IndependenceGate>
    );
    expect(screen.queryByText(/reviewing independently/)).not.toBeInTheDocument();
    expect(screen.getByText("Both independent reviews are in.")).toBeInTheDocument();
  });
});
