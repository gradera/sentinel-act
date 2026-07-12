"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@sentinel-act/ui/lib/utils";
import { useUnsavedCloseGuard } from "@sentinel-act/ui/lib/use-unsaved-close-guard";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    data-slot="dialog-overlay"
    className={cn(
      "fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

interface DialogContentProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  showCloseButton?: boolean;
  /** Spec 14 FR-23: when true, Escape and outside-click show an inline
   *  "discard unsaved changes?" confirm instead of closing immediately —
   *  e.g. pass `rationale.trim().length > 0` from a sign-off sheet. */
  hasUnsavedChanges?: boolean;
}

const DialogContent = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Content>, DialogContentProps>(
  (
    { className, children, showCloseButton = true, hasUnsavedChanges, onEscapeKeyDown, onPointerDownOutside, ...props },
    ref
  ) => {
    const { confirming, guardEscape, guardOutsideInteract, cancelDiscard } = useUnsavedCloseGuard(hasUnsavedChanges);

    return (
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          ref={ref}
          data-slot="dialog-content"
          onEscapeKeyDown={(e) => {
            guardEscape(e);
            onEscapeKeyDown?.(e);
          }}
          onPointerDownOutside={(e) => {
            guardOutsideInteract(e);
            onPointerDownOutside?.(e);
          }}
          className={cn(
            "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
            className
          )}
          {...props}
        >
          {children}
          {showCloseButton && (
            <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none">
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          )}
          {confirming && (
            <div
              role="alertdialog"
              aria-label="Discard unsaved changes?"
              data-slot="dialog-unsaved-confirm"
              className="absolute inset-x-4 bottom-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-[hsl(var(--risk-escalate))]/40 bg-[hsl(var(--risk-escalate))]/10 p-3 text-sm"
            >
              <span>You have unsaved changes. Discard them?</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={cancelDiscard}
                  className="rounded-md border border-input bg-background px-2 py-1 text-xs font-medium hover:bg-secondary"
                >
                  Keep editing
                </button>
                <DialogPrimitive.Close asChild>
                  <button
                    type="button"
                    className="rounded-md bg-destructive px-2 py-1 text-xs font-medium text-destructive-foreground hover:bg-destructive/90"
                  >
                    Discard
                  </button>
                </DialogPrimitive.Close>
              </div>
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPortal>
    );
  }
);
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div data-slot="dialog-header" className={cn("flex flex-col space-y-1.5 text-center sm:text-left", className)} {...props} />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div data-slot="dialog-footer" className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)} {...props} />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} data-slot="dialog-title" className={cn("text-lg font-semibold leading-none tracking-tight", className)} {...props} />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} data-slot="dialog-description" className={cn("text-sm text-muted-foreground", className)} {...props} />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription
};
