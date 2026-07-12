import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dialog, DialogTrigger, DialogContent, DialogTitle } from "./dialog";
import { Sheet, SheetTrigger, SheetContent, SheetTitle } from "./sheet";
import { AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogTitle } from "./alert-dialog";

/**
 * Spec 14 FR-23 — targeted Dialog/Sheet/AlertDialog interaction test:
 * Escape must close normally when there are no unsaved changes, but
 * must show a confirm-discard step (and NOT close) when
 * `hasUnsavedChanges` is true, closing only once the user explicitly
 * confirms "Discard".
 */
describe("FR-23: Escape-with-unsaved-changes guard", () => {
  it("Dialog closes normally on Escape when there are no unsaved changes", async () => {
    const user = userEvent.setup();
    render(
      <Dialog defaultOpen>
        <DialogTrigger>Open</DialogTrigger>
        <DialogContent hasUnsavedChanges={false}>
          <DialogTitle>Confirm reject</DialogTitle>
        </DialogContent>
      </Dialog>
    );
    expect(screen.getByText("Confirm reject")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByText("Confirm reject")).not.toBeInTheDocument();
  });

  it("Dialog shows a discard-confirm on Escape (and does not close) when there are unsaved changes, then closes on explicit Discard", async () => {
    const user = userEvent.setup();
    render(
      <Dialog defaultOpen>
        <DialogTrigger>Open</DialogTrigger>
        <DialogContent hasUnsavedChanges>
          <DialogTitle>Confirm reject</DialogTitle>
        </DialogContent>
      </Dialog>
    );

    await user.keyboard("{Escape}");
    // Still open — the underlying dialog content must not have closed.
    expect(screen.getByText("Confirm reject")).toBeInTheDocument();
    expect(screen.getByRole("alertdialog", { name: "Discard unsaved changes?" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByText("Confirm reject")).not.toBeInTheDocument();
  });

  it("Dialog's discard-confirm can be dismissed via Keep editing, leaving the dialog open", async () => {
    const user = userEvent.setup();
    render(
      <Dialog defaultOpen>
        <DialogTrigger>Open</DialogTrigger>
        <DialogContent hasUnsavedChanges>
          <DialogTitle>Confirm reject</DialogTitle>
        </DialogContent>
      </Dialog>
    );

    await user.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog", { name: "Discard unsaved changes?" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("alertdialog", { name: "Discard unsaved changes?" })).not.toBeInTheDocument();
    expect(screen.getByText("Confirm reject")).toBeInTheDocument();
  });

  it("Sheet (SignOffPanel's real primitive) guards Escape the same way when rationale text is uncommitted", async () => {
    const user = userEvent.setup();
    render(
      <Sheet defaultOpen>
        <SheetTrigger>Open</SheetTrigger>
        <SheetContent hasUnsavedChanges>
          <SheetTitle>Sign off</SheetTitle>
        </SheetContent>
      </Sheet>
    );

    await user.keyboard("{Escape}");
    expect(screen.getByText("Sign off")).toBeInTheDocument();
    expect(screen.getByRole("alertdialog", { name: "Discard unsaved changes?" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByText("Sign off")).not.toBeInTheDocument();
  });

  it("Sheet closes normally on Escape when there are no unsaved changes", async () => {
    const user = userEvent.setup();
    render(
      <Sheet defaultOpen>
        <SheetTrigger>Open</SheetTrigger>
        <SheetContent hasUnsavedChanges={false}>
          <SheetTitle>Sign off</SheetTitle>
        </SheetContent>
      </Sheet>
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByText("Sign off")).not.toBeInTheDocument();
  });

  it("AlertDialog guards Escape the same way when hasUnsavedChanges is set", async () => {
    const user = userEvent.setup();
    render(
      <AlertDialog defaultOpen>
        <AlertDialogTrigger>Open</AlertDialogTrigger>
        <AlertDialogContent hasUnsavedChanges>
          <AlertDialogTitle>Reject with rationale</AlertDialogTitle>
        </AlertDialogContent>
      </AlertDialog>
    );

    await user.keyboard("{Escape}");
    expect(screen.getByText("Reject with rationale")).toBeInTheDocument();
    expect(screen.getByRole("alertdialog", { name: "Discard unsaved changes?" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByText("Reject with rationale")).not.toBeInTheDocument();
  });
});
